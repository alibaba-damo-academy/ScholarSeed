import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserSnapshot } from '../../../../browser'
import { browserPageTitle, subscribeBrowserTitle } from './title.ts'

const snapshot = {
  tabs: [{ tabId: 'page', title: 'Research', url: 'https://example.org/' }],
  activeTabId: 'page',
  automation: { enabled: false, port: null },
} as BrowserSnapshot

test('active page title falls back to URL and blank pages use the localized host fallback', () => {
  assert.equal(browserPageTitle(snapshot), 'Research')
  assert.equal(
    browserPageTitle({ ...snapshot, tabs: [{ ...snapshot.tabs[0], title: '' }] }),
    'https://example.org/'
  )
  assert.equal(
    browserPageTitle({ ...snapshot, tabs: [{ ...snapshot.tabs[0], url: 'about:blank' }] }),
    ''
  )
})

test('workspace title lookup uses the bound page rather than the globally active page', () => {
  const pages = {
    ...snapshot,
    tabs: [...snapshot.tabs, { ...snapshot.tabs[0], tabId: 'other', title: 'Other research' }],
    activeTabId: 'other',
  }
  assert.equal(browserPageTitle(pages, 'page'), 'Research')
  assert.equal(browserPageTitle(pages, 'other'), 'Other research')
  assert.equal(browserPageTitle(pages, 'missing'), '')
})

test('title subscription rejects a stale seed and late results after unmount', async () => {
  let listener!: (snapshot: BrowserSnapshot) => void
  let seed!: (reply: { ok: true; snapshot: BrowserSnapshot }) => void
  const titles: string[] = []
  const dispose = subscribeBrowserTitle(
    {
      subscribe: (callback) => {
        listener = callback
        return () => undefined
      },
      snapshot: () =>
        new Promise((resolve) => {
          seed = resolve
        }),
    },
    (title) => titles.push(title)
  )
  listener(snapshot)
  seed({ ok: true, snapshot: { ...snapshot, activeTabId: null } })
  await Promise.resolve()
  assert.deepEqual(titles, ['Research'])
  dispose()
  listener(snapshot)
  assert.deepEqual(titles, ['Research'])
})
