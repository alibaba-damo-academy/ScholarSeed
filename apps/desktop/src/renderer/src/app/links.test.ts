import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { openWebPage, webPageErrorKey } from './links.ts'

test('web navigation distinguishes a policy rejection from an unexpected failure', () => {
  assert.equal(webPageErrorKey(new Error('permission_denied')), 'browser:errors.permission_denied')
  assert.equal(webPageErrorKey(new Error('unexpected')), 'browser:errors.operation_failed')
})

test('web navigation opens the returned browser page without replacing the conversation', async () => {
  const calls: unknown[] = []
  await openWebPage('https://www.wikipedia.org/', {
    available: true,
    dispatch: async (command) => {
      calls.push(command)
      return { ok: true, snapshot: { activeTabId: 'page-wikipedia' } } as never
    },
    reveal: (options) => calls.push(options),
  })
  assert.deepEqual(calls, [
    { kind: 'open', input: 'https://www.wikipedia.org/' },
    { preserveProject: true, browserPageId: 'page-wikipedia', browserPageOwned: true },
  ])
})

test('browser rejection does not reveal a stale page or fall back externally', async () => {
  await assert.rejects(
    openWebPage('https://example.com/', {
      available: true,
      dispatch: async () => ({ ok: false, error: 'navigation_failed' }),
      reveal: () => assert.fail('stale browser page revealed'),
    }),
    /navigation_failed/
  )
})

test('browser-disabled hosts fail explicitly instead of silently navigating externally', async () => {
  await assert.rejects(
    openWebPage('https://example.com/', {
      available: false,
      dispatch: async () => assert.fail('unavailable browser dispatched'),
      reveal: () => assert.fail('unavailable browser revealed'),
    })
  )
})

test('transport errors propagate without opening an external browser', async () => {
  await assert.rejects(
    openWebPage('https://example.com/', {
      available: true,
      dispatch: async () => {
        throw new Error('bridge_unavailable')
      },
      reveal: () => assert.fail('failed navigation revealed'),
    }),
    /bridge_unavailable/
  )
})

test('user links, search results, Markdown and citations consume shared web navigation', () => {
  const adapters = [
    '../components/business/Message.tsx',
    '../components/business/Stream.tsx',
    '../components/primitive/Markdown.tsx',
    '../features/assistant/Citations.tsx',
    '../features/assistant/References.tsx',
    '../features/resources/WebSearchTab.tsx',
  ]
  for (const adapter of adapters) {
    const source = readFileSync(new URL(adapter, import.meta.url), 'utf8')
    assert.match(source, /useContext\(WebNavigationContext\)/, adapter)
    assert.doesNotMatch(source, /window\.scholarseed\??\.openExternal/, adapter)
  }
  const browser = readFileSync(new URL('../features/browser/Browser.tsx', import.meta.url), 'utf8')
  assert.match(browser, /\.openExternal\(active.url\)/)
  const authorization = readFileSync(
    new URL('../features/skills/Connectors.tsx', import.meta.url),
    'utf8'
  )
  assert.match(authorization, /await openExternal\(authorizationUrl\(url\)\)/)
})
