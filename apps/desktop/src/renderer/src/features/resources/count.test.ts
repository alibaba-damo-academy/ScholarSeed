import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchResourceCount } from './api.ts'

/**
 * 项目卡上的「资料」曾恒为 0：前端读的 `project.file_count` 后端从来不生产。
 * 这里钉住替换它的取数函数——计数只能来自完整枚举端点，且**空项目的 0** 与
 * **没取到的 null** 必须是两个值，否则同一个 bug 会以「请求失败也显示 0」的
 * 形态回来，而用户看不出区别。
 */
test('resource count reads the enumeration endpoint and keeps 0 distinct from failure', async () => {
  const originalFetch = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window & typeof globalThis
  try {
    const seen: string[] = []
    let status = 200
    let body: Record<string, unknown> = { project: 'p1', files: 3 }
    globalThis.fetch = async (url, init) => {
      const parsed = new URL(String(url))
      seen.push(parsed.search ? `${parsed.pathname}?${parsed.searchParams}` : parsed.pathname)
      assert.equal(init?.credentials, 'include')
      return Response.json(body, { status })
    }

    assert.equal(await fetchResourceCount('p1'), 3)
    assert.deepEqual(seen, ['/api/resource/count?project=p1'], '计数不得改用带分页上限的树投影')

    assert.equal(await fetchResourceCount(), 3)
    assert.equal(seen.at(-1), '/api/resource/count', '不传项目时走当前项目，不带空参数')

    body = { project: 'p1', files: 0 }
    assert.equal(await fetchResourceCount('p1'), 0, '空项目是 0')

    status = 503
    assert.equal(await fetchResourceCount('p1'), null, '请求失败不是 0')

    status = 200
    body = { project: 'p1' }
    assert.equal(await fetchResourceCount('p1'), null, '响应缺计数不是 0')
  } finally {
    globalThis.fetch = originalFetch
    globalThis.window = originalWindow
  }
})
