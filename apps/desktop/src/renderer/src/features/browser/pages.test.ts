import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserBridge, BrowserReply, BrowserSnapshot } from '../../../../browser'
import { BrowserPages } from './pages.ts'

test('a viewer can seed only its retained page from the latest snapshot', () => {
  const pages = new BrowserPages({
    dispatch: async () => {
      assert.fail('reading a retained snapshot must not dispatch')
    },
  })
  const snapshot = {
    tabs: [
      { tabId: 'retained', url: 'https://example.org/' },
      { tabId: 'other', url: 'about:blank' },
    ],
    activeTabId: 'other',
    automation: { enabled: false, port: null },
  } as BrowserSnapshot
  pages.remember(snapshot)
  assert.equal(pages.snapshotFor('retained'), snapshot)
  assert.equal(pages.snapshotFor('missing'), undefined)
  pages.remember({ ...snapshot, tabs: snapshot.tabs.slice(1) })
  assert.equal(pages.snapshotFor('retained'), undefined)
  assert.ok(pages.snapshotFor('other'))
  pages.remember()
  assert.equal(pages.snapshotFor('other'), undefined)
})

test('concurrent creation binds the returned page rather than the globally active page', async () => {
  let created = 0
  const pages = new BrowserPages({
    dispatch: async () => ({
      ok: true,
      openedTabId: `owned-${++created}`,
      snapshot: {
        tabs: [],
        activeTabId: 'another-page',
        automation: { enabled: false, port: null },
      },
    }),
  })
  assert.deepEqual(await Promise.all([pages.acquire('first'), pages.acquire('second')]), [
    'owned-1',
    'owned-2',
  ])
})

test('each workspace tab owns one native page and repeated acquisition shares creation', async () => {
  let created = 0
  const closed: string[] = []
  const bridge = {
    dispatch: async (command: { kind: string; tabId?: string }) => {
      if (command.kind === 'close') closed.push(command.tabId!)
      return {
        ok: true,
        openedTabId: `page-${created + 1}`,
        snapshot: {
          tabs: [],
          activeTabId: `page-${++created}`,
          automation: { enabled: false, port: null },
        },
      } as BrowserReply
    },
  } as Pick<BrowserBridge, 'dispatch'>
  const pages = new BrowserPages(bridge)
  const first = pages.acquire('first')
  assert.equal(pages.acquire('first'), first)
  assert.equal(await first, 'page-1')
  assert.equal(await pages.acquire('second'), 'page-2')
  await pages.release('first')
  assert.deepEqual(closed, ['page-1'])
})

test('closing a workspace tab while creation is pending closes only its late page', async () => {
  let finish!: (reply: BrowserReply) => void
  const closed: string[] = []
  const pages = new BrowserPages({
    dispatch: (command) => {
      if (command.kind === 'open')
        return new Promise((resolve) => {
          finish = resolve
        })
      if (command.kind === 'close') closed.push(command.tabId)
      return Promise.resolve({
        ok: true,
        snapshot: { tabs: [], activeTabId: null, automation: { enabled: false, port: null } },
      })
    },
  })
  const acquiring = pages.acquire('closed')
  const releasing = pages.release('closed')
  finish({
    ok: true,
    openedTabId: 'late-page',
    snapshot: { tabs: [], activeTabId: 'late-page', automation: { enabled: false, port: null } },
  })
  await Promise.all([acquiring, releasing])
  assert.deepEqual(closed, ['late-page'])
})

test('already-open manual pages can be owned while externally-closed pages are forgotten', async () => {
  const closed: string[] = []
  const pages = new BrowserPages({
    dispatch: async (command) => {
      assert.equal(command.kind, 'close')
      if (command.kind === 'close') closed.push(command.tabId)
      return {
        ok: true,
        snapshot: { tabs: [], activeTabId: null, automation: { enabled: false, port: null } },
      }
    },
  })
  pages.own('manual', 'manual-page')
  await pages.release('manual')
  pages.own('gone', 'gone-page')
  pages.forget('gone')
  await pages.release('gone')
  await pages.release('borrowed-agent-page')
  assert.deepEqual(closed, ['manual-page'])
  await pages.release('restored-manual-owner', 'restored-manual-page')
  assert.deepEqual(closed, ['manual-page', 'restored-manual-page'])
})
