import assert from 'node:assert/strict'
import test from 'node:test'
import { literatureErrorMessage } from './error.ts'

import {
  addLiteratureNote,
  createLiteratureCollection,
  fetchPaperMeta,
  getLiteratureFacets,
  importPdf,
  LiteratureApiError,
  linkLiteraturesToProject,
  listAllLiteratures,
  literatureQueryKey,
  listLiteratureNotes,
  updateLiteratureNote
} from './api.ts'
import { classifyPaperMetaFailure } from './metadata.ts'

for (const projectId of [undefined, 'project-library']) {
  for (const total of [0, 100, 251]) {
    test(`single-page literature loads ${total} items for ${projectId ?? 'overview'}`, async (context) => {
      const previousWindow = globalThis.window
      const previousFetch = globalThis.fetch
      const requests: URL[] = []
      const source = Array.from({ length: total }, (_, index) => ({ id: `paper-${index}` }))
      Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
        location: { href: 'http://desktop.test/' },
        scholarseed: { getApiBase: () => 'http://service.test' }
      } })
      context.after(() => {
        globalThis.fetch = previousFetch
        Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
      })
      globalThis.fetch = async (input) => {
        const url = new URL(String(input))
        requests.push(url)
        const page = Number(url.searchParams.get('page'))
        const size = Number(url.searchParams.get('page_size'))
        const items = source.slice((page - 1) * size, page * size)
        return Response.json({
          items, total, page, page_size: size,
          next_cursor: items.length === size ? String(page + 1) : null
        })
      }
      const items = await listAllLiteratures({
        project_id: projectId, q: 'research', collection_id: ['collection-a', 'collection-b'],
        tag_id: ['tag-a'], sort: 'title', order: 'asc', page: 9, page_size: 1
      })
      assert.deepEqual(items, source)
      // 200 是服务端 MAX_PAGE_SIZE: 整表加载必须一页取满, 否则 2000+ 条会退化成几十次
      // 串行往返。调用方自己传的 page_size (上面是 1) 一律被覆盖, 这里连带钉住。
      assert.equal(requests.length, Math.max(1, Math.ceil(total / 200)))
      for (const [index, request] of requests.entries()) {
        assert.equal(request.searchParams.get('page'), String(index + 1))
        assert.equal(request.searchParams.get('page_size'), '200')
        assert.equal(request.searchParams.get('project_id'), projectId ?? null)
        assert.equal(request.searchParams.get('q'), 'research')
        assert.deepEqual(request.searchParams.getAll('collection_id'), ['collection-a', 'collection-b'])
        assert.deepEqual(request.searchParams.getAll('tag_id'), ['tag-a'])
        assert.equal(request.searchParams.get('sort'), 'title')
        assert.equal(request.searchParams.get('order'), 'asc')
      }
    })
  }
}

test('single-page literature cancels obsolete queries and does not return partial failures', async (context) => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const controller = new AbortController()
  let calls = 0
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: {
    location: { href: 'http://desktop.test/' },
    scholarseed: { getApiBase: () => 'http://service.test' }
  } })
  context.after(() => {
    globalThis.fetch = previousFetch
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: previousWindow })
  })
  globalThis.fetch = async (_input, init) => {
    calls += 1
    assert.equal(init?.signal, controller.signal)
    controller.abort()
    return Response.json({ items: [{ id: 'first' }], total: 2, page: 1, page_size: 1, next_cursor: '2' })
  }
  await assert.rejects(listAllLiteratures({}, controller.signal), { name: 'AbortError' })
  assert.equal(calls, 1)
  calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return calls === 1
      ? Response.json({ items: [{ id: 'first' }], total: 2, page: 1, page_size: 1, next_cursor: '2' })
      : Response.json({ detail: 'unavailable' }, { status: 503 })
  }
  await assert.rejects(listAllLiteratures({}), LiteratureApiError)
  assert.equal(calls, 2)
})

test('joining literature to a project sends the explicit target project', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  let observedUrl = ''
  let observedBody: unknown
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      location: { href: 'http://desktop.test/' },
      scholarseed: { getApiBase: () => 'http://service.test' }
    }
  })
  globalThis.fetch = async (input, init) => {
    observedUrl = String(input)
    observedBody = JSON.parse(String(init?.body))
    return Response.json({ succeeded: ['paper-1'], failed: [] })
  }
  try {
    const result = await linkLiteraturesToProject(['paper-1'], 'project-1')

    assert.deepEqual(result, { succeeded: ['paper-1'], failed: [] })
    assert.equal(observedUrl, 'http://service.test/api/v1/literatures/bulk')
    assert.deepEqual(observedBody, {
      literature_ids: ['paper-1'],
      operation: 'link_project',
      parameters: { project_id: 'project-1' }
    })
  } finally {
    globalThis.fetch = previousFetch
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: previousWindow
    })
  }
})

test('structured notes use stable create, list and patch contracts', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  const requests: Array<{ method: string; url: string; body: unknown }> = []
  const note = {
    id: 'note-1', title: '笔记 1', text: '# Draft', created_at: 1,
    updated_at: 1, version: 1, position: 1
  }
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      location: { href: 'http://desktop.test/' },
      scholarseed: { getApiBase: () => 'http://service.test' }
    }
  })
  globalThis.fetch = async (input, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    requests.push({ method: init?.method ?? 'GET', url: String(input), body })
    if (init?.method === 'POST') return Response.json(note, { status: 201 })
    if (init?.method === 'PATCH') {
      return Response.json({ ...note, title: body.title, text: body.text, version: 2 })
    }
    return Response.json({ items: [note] })
  }
  try {
    const created = await addLiteratureNote('paper 1', '# Draft')
    const listed = await listLiteratureNotes('paper 1')
    const updated = await updateLiteratureNote('paper 1', created.id, {
      title: 'Methods', text: '# Final', version: created.version
    })

    assert.equal(listed[0].id, created.id)
    assert.equal(updated.id, created.id)
    assert.equal(updated.version, 2)
    assert.deepEqual(requests.map(({ method, body }) => ({ method, body })), [
      { method: 'POST', body: { title: '', text: '# Draft' } },
      { method: 'GET', body: undefined },
      { method: 'PATCH', body: { title: 'Methods', text: '# Final', version: 1 } }
    ])
    assert.ok(requests.every(({ url }) => url.includes('/literatures/paper%201/notes')))
  } finally {
    globalThis.fetch = previousFetch
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: previousWindow
    })
  }
})

test('creating a child literature collection sends its parent id', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  let observedUrl = ''
  let observedBody: unknown
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: {
      location: { href: 'http://desktop.test/' },
      scholarseed: { getApiBase: () => 'http://service.test' }
    }
  })
  globalThis.fetch = async (input, init) => {
    observedUrl = String(input)
    observedBody = JSON.parse(String(init?.body))
    return Response.json({
      id: 'child-1',
      name: 'Child',
      project_id: 'project-1',
      parent_id: 'parent-1',
      count: 0
    })
  }
  try {
    const result = await createLiteratureCollection('Child', 'project-1', 'parent-1')

    assert.deepEqual(result, {
      id: 'child-1',
      name: 'Child',
      project_id: 'project-1',
      parent_id: 'parent-1',
      count: 0
    })
    assert.equal(observedUrl, 'http://service.test/api/v1/collections')
    assert.deepEqual(observedBody, {
      name: 'Child',
      project_id: 'project-1',
      parent_id: 'parent-1'
    })
  } finally {
    globalThis.fetch = previousFetch
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      writable: true,
      value: previousWindow
    })
  }
})

test('request fallback keeps HTTP identity and leaves app wording to the descriptor', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  Object.assign(globalThis, { window: { location: { href: 'http://desktop.test/' }, scholarseed: { getApiBase: () => 'http://service.test' } } })
  try {
    globalThis.fetch = async () => new Response('unparseable', { status: 503 })
    await assert.rejects(getLiteratureFacets({}), (error: unknown) => {
      assert.ok(error instanceof LiteratureApiError)
      assert.equal(error.failure.status, 503)
      assert.equal(error.message, '')
      assert.deepEqual(literatureErrorMessage(error.failure.code, error.message, 'batch.loadFailed'), { key: 'batch.loadFailed', detail: undefined })
      return true
    })
    globalThis.fetch = async () => Response.json({ detail: { code: 'VENDOR_ERROR', message: '原始诊断' } }, { status: 502 })
    await assert.rejects(getLiteratureFacets({}), (error: unknown) => {
      assert.ok(error instanceof LiteratureApiError)
      assert.equal(error.failure.code, 'VENDOR_ERROR')
      assert.equal(error.message, '原始诊断')
      assert.deepEqual(literatureErrorMessage(error.failure.code, error.message, 'batch.loadFailed'), { key: 'batch.loadFailed', detail: undefined })
      return true
    })
  } finally { globalThis.window = previousWindow; globalThis.fetch = previousFetch }
})

test('literature query identity follows content, not object identity', () => {
  const recentScope = {
    attachment: 'any' as const,
    order: 'desc' as const,
    sort: 'created_at' as const,
    project_id: 'project-library',
    recent: true,
    page: 1,
    page_size: 50
  }
  // catalog 每次 query()/filter() 都换一个新对象; 内容相同就必须是同一个身份,
  // 否则列表 effect 会取消在飞请求再重拉一遍。
  assert.equal(
    literatureQueryKey(recentScope),
    literatureQueryKey({ ...recentScope })
  )
  assert.equal(
    literatureQueryKey(recentScope),
    literatureQueryKey({
      page_size: 50,
      page: 1,
      recent: true,
      project_id: 'project-library',
      sort: 'created_at',
      order: 'desc',
      attachment: 'any'
    })
  )
  assert.notEqual(literatureQueryKey(recentScope), literatureQueryKey({ ...recentScope, recent: undefined }))
  assert.notEqual(literatureQueryKey(recentScope), literatureQueryKey({ ...recentScope, page: 2 }))
  // 与 url() 同一口径: 空值不参与身份, 数组展开成同名多值 (顺序不影响服务端语义)。
  assert.equal(literatureQueryKey({ q: '', without_project: false, tag_id: undefined }), '')
  assert.equal(literatureQueryKey({ tag_id: ['second', 'first'] }), literatureQueryKey({ tag_id: ['first', 'second'] }))
})

test('PDF upload network and malformed-success failures expose stable display codes', async () => {
  const previousWindow = globalThis.window
  const previousXHR = globalThis.XMLHttpRequest
  let mode = 'network'
  const requests: Array<{ method: string; endpoint: string; body: unknown }> = []
  class FakeXHR {
    upload = {}
    status = 0
    responseText = ''
    onerror?: () => void
    onload?: () => void
    method = ''
    endpoint = ''
    headers = new Headers()
    setRequestHeader(name: string, value: string) { this.headers.set(name, value) }
    open(method: string, endpoint: string) { this.method = method; this.endpoint = endpoint }
    send(body: unknown) {
      assert.ok(this.headers.get('Idempotency-Key'))
      requests.push({ method: this.method, endpoint: this.endpoint, body })
      if (mode === 'network') this.onerror?.()
      else { this.status = 200; this.responseText = '{}'; this.onload?.() }
    }
  }
  Object.assign(globalThis, { window: { location: { href: 'http://desktop.test/' }, scholarseed: { getApiBase: () => 'http://service.test' } }, XMLHttpRequest: FakeXHR })
  try {
    const file = new File(['pdf'], '原文.pdf', { type: 'application/pdf' })
    for (const [next, code, key] of [['network', 'PDF_UPLOAD_NETWORK_FAILED', 'pdfImport.networkFailed'], ['invalid', 'PDF_IMPORT_INVALID_RESPONSE', 'pdfImport.invalidResponse']]) {
      mode = next
      await assert.rejects(importPdf(file), (error: unknown) => {
        assert.ok(error instanceof LiteratureApiError)
        assert.equal(error.failure.code, code)
        assert.equal(error.message, '')
        assert.deepEqual(literatureErrorMessage(error.failure.code, error.message, 'pdfImport.parseFailed'), { key })
        return true
      })
    }
    assert.ok(requests.every(item => item.method === 'POST' && item.endpoint === 'http://service.test/api/v1/imports/pdf'))
    assert.ok(requests.every(item => item.body instanceof FormData && item.body.get('file') instanceof File))
  } finally { globalThis.window = previousWindow; globalThis.XMLHttpRequest = previousXHR }
})

test('metadata sync posts only the chosen dimension and keeps the payload verbatim', async () => {
  const previousWindow = globalThis.window
  const previousFetch = globalThis.fetch
  // 三条腿同形: serve 已经把上游归一化成更新体, 渲染层原样收下不再解析。
  const payload = {
    success: true,
    bib_type: 'article',
    fields: { title: 'Attention is All You Need', year: 2017, arxiv: '1706.03762' }
  }
  let observedUrl = ''
  let observedInit: RequestInit | undefined
  Object.assign(globalThis, { window: { location: { href: 'http://desktop.test/' }, scholarseed: { getApiBase: () => 'http://service.test' } } })
  try {
    globalThis.fetch = async (input, init) => {
      observedUrl = String(input)
      observedInit = init
      return Response.json(payload)
    }
    assert.deepEqual(await fetchPaperMeta({ dimension: 'arxiv', value: '1706.03762' }), payload)
    assert.equal(observedUrl, 'http://service.test/api/literature/papermeta')
    assert.equal(observedInit?.method, 'POST')
    assert.deepEqual(JSON.parse(String(observedInit?.body)), { arxiv: '1706.03762' })

    globalThis.fetch = async () => Response.json(
      { detail: { code: 'PAPER_META_QUOTA_EXHAUSTED', message: '元数据接口限流，请稍后重试' } },
      { status: 429 }
    )
    await assert.rejects(fetchPaperMeta({ dimension: 'doi', value: '10.1/x' }), (error: unknown) => {
      assert.ok(error instanceof LiteratureApiError)
      assert.equal(error.failure.status, 429)
      assert.equal(classifyPaperMetaFailure(error.failure), 'quota')
      return true
    })

    // 0 命中是可行动的「没这篇」, 与限流一样单独分类, 不折进笼统的 failed。
    globalThis.fetch = async () => Response.json({ detail: { code: 'PAPER_META_NOT_FOUND' } }, { status: 404 })
    await assert.rejects(fetchPaperMeta({ dimension: 'title', value: 'Nothing like this' }), (error: unknown) => {
      assert.ok(error instanceof LiteratureApiError)
      assert.equal(error.failure.status, 404)
      assert.equal(classifyPaperMetaFailure(error.failure), 'missing')
      return true
    })
  } finally { globalThis.window = previousWindow; globalThis.fetch = previousFetch }
})
