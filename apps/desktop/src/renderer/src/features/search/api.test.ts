import assert from 'node:assert/strict'
import test from 'node:test'

import { FIND_TEXT_REVEAL_KIND, type FindTextReveal } from '../../contracts/workbench.ts'
import { searchEverything, type GlobalHit } from './api.ts'

const API_BASE = 'http://serve.test'

interface RecordedCall {
  url: string
  init: RequestInit | undefined
}

/**
 * 只替换宿主桥与 fetch：全局搜索的取数腿必须是纯 HTTP，测试里既不能真发请求，
 * 也不能碰 Electron preload。restore() 还原全局，避免污染同进程其它用例。
 */
function searchBrowser(
  fetcher: typeof fetch,
  bridge: Record<string, unknown> | null = { getApiBase: () => API_BASE }
): { calls: RecordedCall[]; restore: () => void } {
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const priorFetch = globalThis.fetch
  const calls: RecordedCall[] = []
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { scholarseed: bridge }
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return fetcher(input, init)
  }) as typeof fetch
  return {
    calls,
    restore() {
      globalThis.fetch = priorFetch
      if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow)
      else Reflect.deleteProperty(globalThis, 'window')
    }
  }
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

const resourceReveal: FindTextReveal = {
  kind: FIND_TEXT_REVEAL_KIND,
  query: '湿度',
  source_revision: 'sha256:revision-1'
}

const resourceHit: GlobalHit = {
  domain: 'resource',
  id: 'resources/notes/perovskite.md',
  title: '钙钛矿稳定性笔记',
  subtitle: 'resources/notes/perovskite.md',
  reveal: resourceReveal
}

const sessionHit: GlobalHit = {
  domain: 'session',
  id: 'session-7',
  title: '文献场景：全流程',
  subtitle: '',
  reveal: null,
  locator: { turn_id: 'turn-3', item_id: 'item-9', role: 'assistant', count: 1 }
}

test('cross-domain search sends the query and project scope to the unified endpoint', async () => {
  const browser = searchBrowser(async () =>
    jsonResponse({ hits: [resourceHit], groups: { resource: { total: 1, truncated: false } } })
  )
  try {
    const result = await searchEverything('钙钛矿', 'project-1')
    assert.equal(browser.calls.length, 1)
    assert.equal(
      browser.calls[0].url,
      `${API_BASE}/api/search?q=${encodeURIComponent('钙钛矿')}&project=project-1`
    )
    // 搜索端点与 serve 同源同 cookie 鉴权：丢 credentials 就会以 401 表现成「没有命中」。
    assert.equal(browser.calls[0].init?.credentials, 'include')
    assert.deepEqual(result, {
      hits: [resourceHit],
      groups: { resource: { total: 1, truncated: false } }
    })
  } finally {
    browser.restore()
  }
})

test('global search leaves the project parameter out instead of sending an empty scope', async () => {
  const browser = searchBrowser(async () => jsonResponse({ hits: [], groups: {} }))
  try {
    for (const scope of [null, undefined, '']) {
      await searchEverything('perovskite', scope)
    }
    assert.deepEqual(
      browser.calls.map((call) => call.url),
      [
        `${API_BASE}/api/search?q=perovskite`,
        `${API_BASE}/api/search?q=perovskite`,
        `${API_BASE}/api/search?q=perovskite`
      ]
    )
  } finally {
    browser.restore()
  }
})

test('a sparse payload is normalized so the panel never reads undefined rows', async () => {
  const browser = searchBrowser(async () => jsonResponse({}))
  try {
    assert.deepEqual(await searchEverything('x'), { hits: [], groups: {} })
  } finally {
    browser.restore()
  }

  const hitsOnly = searchBrowser(async () =>
    jsonResponse({ hits: [sessionHit], groups: undefined })
  )
  try {
    assert.deepEqual(await searchEverything('x'), { hits: [sessionHit], groups: {} })
  } finally {
    hitsOnly.restore()
  }

  const groupsOnly = searchBrowser(async () =>
    jsonResponse({ groups: { session: { total: 12, truncated: true } } })
  )
  try {
    assert.deepEqual(await searchEverything('x'), {
      hits: [],
      groups: { session: { total: 12, truncated: true } }
    })
  } finally {
    groupsOnly.restore()
  }
})

test('navigation payload survives the transform for both resource and session hits', async () => {
  const browser = searchBrowser(async () =>
    jsonResponse({
      hits: [resourceHit, sessionHit],
      groups: {
        resource: { total: 1, truncated: false },
        session: { total: 1, truncated: false }
      }
    })
  )
  try {
    const result = await searchEverything('钙钛矿')
    assert.ok(result)
    // reveal 只有资料正文命中才有；会话命中带 locator 供跳转到具体 turn/item。
    assert.deepEqual(result.hits[0].reveal, resourceReveal)
    assert.deepEqual(result.hits[1].locator, {
      turn_id: 'turn-3',
      item_id: 'item-9',
      role: 'assistant',
      count: 1
    })
  } finally {
    browser.restore()
  }
})

test('an HTTP failure stays distinguishable from a genuine empty result', async () => {
  const failing = searchBrowser(async () => jsonResponse({ code: 'boom' }, 500))
  try {
    assert.equal(await searchEverything('x'), null)
  } finally {
    failing.restore()
  }

  const missing = searchBrowser(async () => jsonResponse({}, 404))
  try {
    assert.equal(await searchEverything('x'), null)
  } finally {
    missing.restore()
  }

  const empty = searchBrowser(async () => jsonResponse({ hits: [], groups: {} }))
  try {
    assert.deepEqual(await searchEverything('x'), { hits: [], groups: {} })
  } finally {
    empty.restore()
  }
})

test('a non-JSON body degrades to null rather than throwing into the panel', async () => {
  const browser = searchBrowser(async () => new Response('<html>gateway error</html>', { status: 200 }))
  try {
    assert.equal(await searchEverything('x'), null)
  } finally {
    browser.restore()
  }
})

test('an offline request is a failure, not an empty result set', async () => {
  const browser = searchBrowser(async () => {
    throw new TypeError('fetch failed')
  })
  try {
    assert.equal(await searchEverything('x', 'project-1'), null)
  } finally {
    browser.restore()
  }
})

test('the caller abort signal reaches fetch so a stale debounced request can be cancelled', async () => {
  const controller = new AbortController()
  const browser = searchBrowser(async () => {
    controller.abort()
    const error = new Error('This operation was aborted')
    error.name = 'AbortError'
    throw error
  })
  try {
    assert.equal(await searchEverything('x', null, controller.signal), null)
    assert.equal(browser.calls[0].init?.signal, controller.signal)
    assert.equal(controller.signal.aborted, true)
  } finally {
    browser.restore()
  }
})

test('a missing host bridge falls back to a same-origin relative URL', async () => {
  const browser = searchBrowser(async () => jsonResponse({ hits: [], groups: {} }), null)
  try {
    await searchEverything('x')
    assert.equal(browser.calls[0].url, '/api/search?q=x')
  } finally {
    browser.restore()
  }
})
