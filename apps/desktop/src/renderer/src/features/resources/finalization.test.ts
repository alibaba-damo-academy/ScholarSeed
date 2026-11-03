import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createInstance } from 'i18next'

import {
  fetchFinalizations,
  finalizationMessage,
  finalizationReason,
  retryFinalization,
} from './finalization.ts'
import {
  applyFileVersionSettings,
  appendVersionPattern,
  fileVersionScanSummary,
  fileVersionSettingsChanges,
  fileVersionSizeKb,
  fileVersionSizeMbText,
  saveFileVersionSettings,
} from './settings.ts'

const i18n = createInstance()
await i18n.init({
  lng: 'zh',
  fallbackLng: false,
  resources: {
    zh: {
      resources: JSON.parse(
        readFileSync(
          new URL('../../../../localization/locales/zh/resources.json', import.meta.url),
          'utf8'
        )
      ),
    },
    en: {
      resources: JSON.parse(
        readFileSync(
          new URL('../../../../localization/locales/en/resources.json', import.meta.url),
          'utf8'
        )
      ),
    },
  },
})

test('common file types append once to either personal rule list', () => {
  assert.equal(appendVersionPattern('*.md\n', '*.pdf'), '*.md\n*.pdf')
  assert.equal(appendVersionPattern('*.md\n*.pdf', '*.pdf'), '*.md\n*.pdf')
})

test('finalization HTTP reads preserve project/session scope and distinguish failure from empty', async () => {
  const original = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  const requests: string[] = []
  try {
    globalThis.fetch = async (url, init) => {
      requests.push(String(url))
      assert.equal(init?.credentials, 'include')
      return new Response(JSON.stringify({ entries: [], next_cursor: null }))
    }
    assert.deepEqual(await fetchFinalizations('project-1', 'session/a', 'turn?1'), {
      entries: [],
      next_cursor: null,
    })
    const params = new URL(requests[0], 'http://test').searchParams
    assert.equal(params.get('project'), 'project-1')
    assert.equal(params.get('session_id'), 'session/a')
    assert.equal(params.get('cursor'), 'turn?1')
    const entry = {
      session_id: 'session/a',
      turn_id: 'turn?1',
      terminal_outcome: 'completed',
      error: 'terminal_snapshot_unavailable',
      paths: [],
      created_at_ms: 1,
      snapshot_available: false,
      retryable: false,
    }
    globalThis.fetch = async () => Response.json({ entries: [entry], next_cursor: null })
    assert.deepEqual(await fetchFinalizations('project-1', 'session/a'), {
      entries: [entry],
      next_cursor: null,
    })
    globalThis.fetch = async () => new Response('unavailable', { status: 503 })
    assert.equal(await fetchFinalizations('project-1', 'session/a'), null)
    globalThis.fetch = async () => {
      throw new Error('offline')
    }
    assert.equal(await fetchFinalizations('project-1', 'session/a'), null)
  } finally {
    globalThis.fetch = original
    globalThis.window = originalWindow
  }
})

test('retry sends no replacement bytes or runtime outcome and preserves error codes', async () => {
  const original = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  try {
    globalThis.fetch = async (url, init) => {
      assert.match(String(url), /finalizations\/turn%2Fa\/retry/)
      assert.equal(init?.method, 'POST')
      assert.equal(init?.body, undefined)
      assert.ok(new Headers(init?.headers).get('Idempotency-Key'))
      return new Response(JSON.stringify({ error: { code: 'terminal_not_retryable' } }), {
        status: 409,
      })
    }
    assert.deepEqual(await retryFinalization('project', 'session', 'turn/a'), {
      ok: false,
      error: 'terminal_not_retryable',
    })
  } finally {
    globalThis.fetch = original
    globalThis.window = originalWindow
  }
})

test('archive messages never describe a missing snapshot as retryable or a failed Agent', () => {
  assert.match(
    finalizationMessage({
      error: 'turn_baseline_unavailable',
      snapshot_available: false,
      retryable: false,
    }),
    /^finalizations\.baselineUnavailable$/
  )
  assert.match(
    finalizationMessage({ error: 'read_failed', snapshot_available: false, retryable: false }),
    /^finalizations\.snapshotUnavailable$/
  )
  assert.match(
    finalizationMessage({ error: 'RuntimeError', snapshot_available: true, retryable: false }),
    /^finalizations\.retryUnsafe$/
  )
  assert.match(
    finalizationMessage({ error: 'RuntimeError', snapshot_available: true, retryable: true }),
    /^finalizations\.snapshotRetained$/
  )
})

test('finalization reasons translate known codes and safely describe unknown errors', () => {
  const cases = [
    [
      'read_failed',
      '无法读取文件，未能保存本轮审阅快照。',
      'Could not read a file, so the review snapshot for this turn could not be saved.',
    ],
    [
      'terminal_snapshot_unavailable',
      '本轮结束时的审阅快照未保存，无法恢复。',
      'The review snapshot at the end of this turn was not saved and cannot be recovered.',
    ],
    [
      'unknown_error',
      '本轮审阅快照处理失败。',
      'The review snapshot for this turn could not be processed.',
    ],
    [
      'constructor',
      '本轮审阅快照处理失败。',
      'The review snapshot for this turn could not be processed.',
    ],
    [
      '__proto__',
      '本轮审阅快照处理失败。',
      'The review snapshot for this turn could not be processed.',
    ],
    ['', '本轮审阅快照处理失败。', 'The review snapshot for this turn could not be processed.'],
  ] as const
  for (const [code, chinese, english] of cases) {
    assert.equal(i18n.getFixedT('zh', 'resources')(finalizationReason(code)), chinese)
    assert.equal(i18n.getFixedT('en', 'resources')(finalizationReason(code)), english)
  }
})

test('confirmed retention apply sends the exact preview token contract', async () => {
  const original = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  try {
    globalThis.fetch = async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        mode: 'whitelist' as const,
        max_versions_per_file: 25,
        max_file_size_kb: 1024,
        include_patterns: '*.md\n*.pdf',
        ignore_patterns: '*.log',
        preview_token: 'preview-1',
      })
      return Response.json({
        mode: 'whitelist' as const,
        max_versions_per_file: 25,
        max_file_size_kb: 1024,
        include_patterns: ['*.md', '*.pdf'],
        ignore_patterns: ['*.log'],
        delete_versions: 2,
        delete_deliveries: 1,
        affected_files: 1,
        token: 'preview-1',
      })
    }
    assert.deepEqual(
      await applyFileVersionSettings(
        {
          mode: 'whitelist' as const,
          max_versions_per_file: 25,
          max_file_size_kb: 1024,
          include_patterns: ['*.md', '*.pdf'],
          ignore_patterns: ['*.log'],
        },
        'preview-1'
      ),
      {
        ok: true,
        result: {
          mode: 'whitelist' as const,
          max_versions_per_file: 25,
          max_file_size_kb: 1024,
          include_patterns: ['*.md', '*.pdf'],
          ignore_patterns: ['*.log'],
          delete_versions: 2,
          delete_deliveries: 1,
          affected_files: 1,
          token: 'preview-1',
        },
      }
    )
  } finally {
    globalThis.fetch = original
    globalThis.window = originalWindow
  }
})

test('settings changes describe only the configuration delta', () => {
  const saved = {
    mode: 'whitelist' as const,
    max_versions_per_file: 50,
    max_file_size_kb: 1024,
    include_patterns: ['*.md'],
    ignore_patterns: ['*.log'],
  }
  assert.deepEqual(fileVersionSettingsChanges(saved, 50, 1024, '*.md\n*.pdf', '*.log\n*.cpp\n'), {
    settings: {
      mode: 'whitelist' as const,
      max_versions_per_file: 50,
      max_file_size_kb: 1024,
      include_patterns: ['*.md', '*.pdf'],
      ignore_patterns: ['*.log', '*.cpp'],
    },
    limit: 'unchanged',
    fileSizeChanged: false,
    includesChanged: true,
    ignoresChanged: true,
    modeChanged: false,
  })
  assert.equal(fileVersionSettingsChanges(saved, 60, 1024, '*.md', '*.log').limit, 'increased')
  assert.equal(fileVersionSettingsChanges(saved, 20, 1024, '*.md', '*.log').limit, 'decreased')
  assert.equal(fileVersionSettingsChanges(saved, 50, 512, '*.md', '*.log').fileSizeChanged, true)
})

test('file size settings edit MB while the API keeps KB', () => {
  assert.equal(fileVersionSizeMbText(50 * 1024), '50')
  assert.equal(fileVersionSizeMbText(1024), '1')
  assert.equal(fileVersionSizeMbText(512), '0.5')
  assert.equal(fileVersionSizeKb('50', 1024), 50 * 1024)
  assert.equal(fileVersionSizeKb('2048', 1024), 2048 * 1024)
  assert.equal(fileVersionSizeKb('0.5', 512), 512)
  assert.equal(fileVersionSizeKb(fileVersionSizeMbText(1000), 1000), 1000)
  assert.equal(fileVersionSizeKb('0', 1024), null)
  assert.equal(fileVersionSizeKb('2049', 1024), null)
  assert.equal(fileVersionSizeKb('1.5', 1024), null)
  assert.equal(fileVersionSizeKb('', 1024), null)
})

test('non-destructive settings save omits a preview token and preserves backend errors', async () => {
  const original = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  try {
    globalThis.fetch = async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        mode: 'whitelist' as const,
        max_versions_per_file: 50,
        max_file_size_kb: 1024,
        include_patterns: '*.md\n*.pdf',
        ignore_patterns: '*.log\n*.cpp',
      })
      return new Response(
        JSON.stringify({
          error: { code: 'settings_write_failed', message: 'settings_write_failed' },
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    }
    assert.deepEqual(
      await applyFileVersionSettings({
        mode: 'whitelist' as const,
        max_versions_per_file: 50,
        max_file_size_kb: 1024,
        include_patterns: ['*.md', '*.pdf'],
        ignore_patterns: ['*.log', '*.cpp'],
      }),
      { ok: false, error: 'settings_write_failed' }
    )
  } finally {
    globalThis.fetch = original
    globalThis.window = originalWindow
  }
})

test('automatic settings save sends one configuration request without preview', async () => {
  const original = globalThis.fetch
  const originalWindow = globalThis.window
  globalThis.window = { scholarseed: { getApiBase: () => 'http://test' } } as Window &
    typeof globalThis
  const requests: Array<{ path: string; token?: string }> = []
  try {
    globalThis.fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body)) as { preview_token?: string }
      requests.push({ path: new URL(String(url)).pathname, token: body.preview_token })
      return Response.json({
        mode: 'whitelist',
        max_versions_per_file: 25,
        max_file_size_kb: 1024,
        include_patterns: ['*.md'],
        ignore_patterns: ['*.log'],
        token: '',
      })
    }
    const settings = {
      mode: 'whitelist' as const,
      max_versions_per_file: 25,
      max_file_size_kb: 1024,
      include_patterns: ['*.md'],
      ignore_patterns: ['*.log'],
    }
    assert.equal((await saveFileVersionSettings(settings)).ok, true)
    assert.deepEqual(requests, [{ path: '/api/serve/settings/file-versions', token: undefined }])
  } finally {
    globalThis.fetch = original
    globalThis.window = originalWindow
  }
})

test('file version scan summary distinguishes active, ignored and oversized state', () => {
  const summary = {
    status: 'scanning',
    projects: 2,
    managed: 8,
    created: 1,
    ignored: 3,
    oversized: 2,
    unsupported: 4,
    failed: 0,
  } as const
  assert.equal(
    fileVersionScanSummary(summary, i18n.getFixedT('zh', 'resources')),
    '正在扫描 2 个项目，8 个文件已纳入历史保存；3 个被排除，2 个超过单文件大小限制。'
  )
  assert.equal(
    fileVersionScanSummary(summary, i18n.getFixedT('en', 'resources')),
    'Scanning 2 projects; 8 files included, 3 excluded, 2 over the per-file size limit.'
  )
  assert.equal(
    fileVersionScanSummary({ ...summary, status: 'idle' }, i18n.getFixedT('en', 'resources')),
    'Scanned 2 projects; 8 files included, 3 excluded, 2 over the per-file size limit.'
  )
})

test('admission policy settings preserve mode and explicit empty whitelist', () => {
  const saved = {
    mode: 'whitelist' as const,
    max_versions_per_file: 50,
    max_file_size_kb: 1024,
    include_patterns: ['*.md'],
    ignore_patterns: ['*.log'],
  }
  assert.equal(
    fileVersionSettingsChanges(saved, 50, 1024, '*.md', '*.log', 'blacklist').modeChanged,
    true
  )
  assert.deepEqual(
    fileVersionSettingsChanges(saved, 50, 1024, '', '*.log', 'whitelist').settings.include_patterns,
    []
  )
  assert.equal(
    fileVersionSettingsChanges(saved, 50, 1024, '*.md', '*.log\n*.tmp', 'whitelist').ignoresChanged,
    true
  )
})
