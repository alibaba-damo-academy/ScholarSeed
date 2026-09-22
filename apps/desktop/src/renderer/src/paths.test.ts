import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createInstance } from 'i18next'

import { openSystemPath, revealSystemPath } from './api.ts'

test('system path requests mark only a missing bridge and preserve returned or thrown diagnostics', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const calls: string[] = []
  try {
    for (const operation of [openSystemPath, revealSystemPath]) {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })
      assert.deepEqual(await operation('/project/原始文件.pdf'), {
        ok: false, error: 'desktop bridge unavailable', applicationFailure: { code: 'desktop_bridge_unavailable' }
      })
      for (const raw of ['desktop bridge unavailable', '原始错误 <path> & {{name}}']) {
        const result = { ok: false, error: raw }
        const bridge = async (path: string) => { calls.push(path); return result }
        Object.defineProperty(globalThis, 'window', { configurable: true, value: { scholarseed: { openPath: bridge, revealPath: bridge } } })
        assert.equal(await operation('/project/原始文件.pdf'), result)
        const rejects = async () => { throw new Error(raw) }
        Object.defineProperty(globalThis, 'window', { configurable: true, value: { scholarseed: { openPath: rejects, revealPath: rejects } } })
        assert.deepEqual(await operation('/project/原始文件.pdf'), { ok: false, error: raw })
      }
      const success = { ok: true, path: '/project/原始文件.pdf' }
      Object.defineProperty(globalThis, 'window', { configurable: true, value: { scholarseed: { openPath: async () => success, revealPath: async () => success } } })
      assert.equal(await operation(success.path), success)
    }
    assert.deepEqual(calls, Array(4).fill('/project/原始文件.pdf'))
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous)
    else Reflect.deleteProperty(globalThis, 'window')
  }
})

test('visible path failure consumers store message identity and redraw in their owning namespace', async () => {
  const resources = Object.fromEntries(['zh', 'en'].map(language => [language, Object.fromEntries(['workbench', 'resources'].map(namespace => [namespace,
    JSON.parse(readFileSync(new URL(`../../localization/locales/${language}/${namespace}.json`, import.meta.url), 'utf8'))
  ]))]))
  const locale = createInstance()
  await locale.init({ lng: 'zh', fallbackLng: false, resources, interpolation: { escapeValue: false } })
  const open = { key: 'dock.desktopUnavailable' } as const
  const reveal = { key: 'feedback.revealDesktopUnavailable' } as const
  assert.equal(locale.t(open.key, { ns: 'workbench' }), '系统打开不可用：桌面连接未就绪。')
  assert.equal(locale.t(reveal.key, { ns: 'resources' }), '无法在文件管理器中显示此资料：桌面连接未就绪。')
  await locale.changeLanguage('en')
  assert.equal(locale.t(open.key, { ns: 'workbench' }), 'System opening is unavailable because the desktop connection is not ready.')
  assert.equal(locale.t(reveal.key, { ns: 'resources' }), 'This resource cannot be shown in the file manager because the desktop connection is not ready.')
  assert.deepEqual(open, { key: 'dock.desktopUnavailable' })
  assert.deepEqual(reveal, { key: 'feedback.revealDesktopUnavailable' })
  const dock = readFileSync(new URL('./features/workbench/Dock.tsx', import.meta.url), 'utf8')
  const external = readFileSync(new URL('./features/workbench/External.tsx', import.meta.url), 'utf8')
  const store = readFileSync(new URL('./store.tsx', import.meta.url), 'utf8')
  for (const source of [external, store]) {
    assert.match(source, /opened.applicationFailure\?\.code === 'desktop_bridge_unavailable'/)
    assert.doesNotMatch(source, /opened.error === 'desktop bridge unavailable'/)
    assert.match(source, /detail: opened.error/)
  }
  assert.match(dock, /useTranslation\('workbench'\)/)
  assert.match(external, /t\(result\.error\?\.key \?\? 'dock\.openFailed'\)/)
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  assert.match(app, /function ResourceNoticeToast\(\)/)
  assert.match(app, /useTranslation\('resources'\)/)
  assert.match(app, /t\(notice.text.key\)/)
})
