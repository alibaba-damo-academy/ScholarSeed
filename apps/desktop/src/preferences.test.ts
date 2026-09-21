import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_RENDERER_PREFERENCES,
  MAX_TRACKED_RECENT_FILES,
  MAX_TRACKED_RECENT_LITERATURE,
  MAX_TRACKED_RECENT_SESSIONS,
  defaultRendererPreferences,
  sanitizeRecentFiles,
  sanitizeRecentLiterature,
  sanitizeRecentSessions,
  sanitizeRendererPreferences,
  recentLiteratureEqual,
  recentSessionsEqual,
  touchRecentFile,
  touchRecentLiterature,
  touchRecentSession
} from './preferences.ts'

test('notification preferences persist while privacy mode remains fail-closed', () => {
  const parsed = sanitizeRendererPreferences({
    sidebarOpen: false,
    sessionActivityInitialized: true,
    sessionActivitySeen: { session: 12 },
    desktopNotifications: false,
    soundAlerts: false,
    dataSharingMode: 'improve'
  })
  assert.equal(parsed.desktopNotifications, false)
  assert.equal(parsed.soundAlerts, false)
  assert.equal(parsed.dataSharingMode, 'private')
})

test('missing notification fields receive the documented defaults', () => {
  const parsed = sanitizeRendererPreferences({})
  assert.equal(parsed.desktopNotifications, DEFAULT_RENDERER_PREFERENCES.desktopNotifications)
  assert.equal(parsed.soundAlerts, DEFAULT_RENDERER_PREFERENCES.soundAlerts)
  assert.equal(parsed.autoSave, true)
})

test('auto-save accepts only an explicit boolean and defaults to enabled for missing or invalid preferences', () => {
  assert.equal(sanitizeRendererPreferences({ autoSave: true }).autoSave, true)
  assert.equal(sanitizeRendererPreferences({ autoSave: false }).autoSave, false)
  assert.equal(sanitizeRendererPreferences({ autoSave: 'true' }).autoSave, true)
  assert.equal(sanitizeRendererPreferences({}).autoSave, true)
})

test('format-on-save accepts only an explicit boolean and defaults to disabled for missing or invalid preferences', () => {
  assert.equal(sanitizeRendererPreferences({ formatOnSave: true }).formatOnSave, true)
  assert.equal(sanitizeRendererPreferences({ formatOnSave: false }).formatOnSave, false)
  assert.equal(sanitizeRendererPreferences({ formatOnSave: 'true' }).formatOnSave, false)
  assert.equal(sanitizeRendererPreferences({}).formatOnSave, false)
})

test('editor word wrap accepts only an explicit boolean and defaults to enabled', () => {
  assert.equal(sanitizeRendererPreferences({ editorWordWrap: true }).editorWordWrap, true)
  assert.equal(sanitizeRendererPreferences({ editorWordWrap: false }).editorWordWrap, false)
  assert.equal(sanitizeRendererPreferences({ editorWordWrap: 'false' }).editorWordWrap, true)
  assert.equal(sanitizeRendererPreferences({}).editorWordWrap, true)
})

test('shortcut overrides preserve valid bindings and explicit cleared commands', () => {
  const parsed = sanitizeRendererPreferences({
    shortcutOverrides: {
      'markdown.bold': { key: 'm', modifiers: ['primary', 'shift'] },
      'code.moveLineUp': { key: 'ArrowUp', modifiers: ['alt'] },
      'pdf.nextPage': { key: 'PageDown', modifiers: [] },
      'workbench.toggleModulePanel': null,
      'office.save': { key: 's', modifiers: ['primary'] },
      invalidKey: { key: '', modifiers: ['primary'] },
      invalidModifier: { key: 'x', modifiers: ['meta'] },
      invalidBareText: { key: 'a', modifiers: [] },
      invalidShiftText: { key: 'A', modifiers: ['shift'] }
    }
  })
  assert.deepEqual(parsed.shortcutOverrides, {
    'markdown.bold': { key: 'm', modifiers: ['primary', 'shift'] },
    'pdf.nextPage': { key: 'PageDown', modifiers: [] }
  })
  assert.deepEqual(sanitizeRendererPreferences({}).shortcutOverrides, {})
})

test('a persisted language survives detection, and only a missing or invalid one takes the fallback', () => {
  // 用户显式选过的语言不能被检测结果覆盖 —— 这是「只首次运行生效」的落点。
  assert.equal(sanitizeRendererPreferences({ language: 'zh' }, 'en').language, 'zh')
  assert.equal(sanitizeRendererPreferences({ language: 'en' }, 'zh').language, 'en')
  // 缺失、非法、整份入参不可用，都算「没有已持久化的选择」。
  assert.equal(sanitizeRendererPreferences({}, 'en').language, 'en')
  assert.equal(sanitizeRendererPreferences({ language: 'fr' }, 'en').language, 'en')
  assert.equal(sanitizeRendererPreferences({ language: null }, 'en').language, 'en')
  assert.equal(sanitizeRendererPreferences(null, 'en').language, 'en')
  // 不传兜底时保持改动前的行为，现有调用方与测试不受影响。
  assert.equal(sanitizeRendererPreferences({}).language, DEFAULT_RENDERER_PREFERENCES.language)
  assert.equal(sanitizeRendererPreferences(null).language, DEFAULT_RENDERER_PREFERENCES.language)
})

test('defaultRendererPreferences substitutes the language without mutating the exported constant', () => {
  const detected = defaultRendererPreferences('en')
  assert.equal(detected.language, 'en')
  assert.deepEqual(detected, { ...DEFAULT_RENDERER_PREFERENCES, language: 'en' })

  assert.deepEqual(defaultRendererPreferences(), DEFAULT_RENDERER_PREFERENCES)
  assert.deepEqual(defaultRendererPreferences('zh'), DEFAULT_RENDERER_PREFERENCES)

  // 兜底语言是检测链的最终结果，常量本身必须保持中文不动。
  assert.equal(DEFAULT_RENDERER_PREFERENCES.language, 'zh')
  assert.notEqual(detected, DEFAULT_RENDERER_PREFERENCES)
})

test('recent files are validated, de-duplicated by project and path, sorted, and bounded', () => {
  const parsed = sanitizeRecentFiles([
    { projectId: 'project-a', path: 'resources/duplicate.md', openedAt: 1 },
    { projectId: 'project-a', path: 'resources/duplicate.md', openedAt: 99 },
    { projectId: 'project-b', path: 'resources/duplicate.md', openedAt: 98 },
    ...Array.from({ length: MAX_TRACKED_RECENT_FILES + 5 }, (_, index) => ({
      projectId: 'project-a',
      path: `resources/file-${index}.md`,
      openedAt: index + 2
    })),
    { projectId: '', path: 'resources/missing-project.md', openedAt: 200 },
    { projectId: 'project-a', path: '', openedAt: 200 },
    { projectId: 'project-a', path: 'resources/not-a-time.md', openedAt: 'now' }
  ])

  assert.equal(parsed.length, MAX_TRACKED_RECENT_FILES)
  assert.deepEqual(parsed[0], {
    projectId: 'project-a',
    path: 'resources/duplicate.md',
    openedAt: 99
  })
  assert.equal(parsed.filter((entry) => entry.path === 'resources/duplicate.md').length, 2)
  assert.ok(parsed.every((entry, index) => index === 0 || parsed[index - 1].openedAt >= entry.openedAt))
})

test('touching an existing recent file moves it to the front without duplicating it', () => {
  const touched = touchRecentFile([
    { projectId: 'project-a', path: 'resources/newer.md', openedAt: 20 },
    { projectId: 'project-a', path: 'resources/older.md', openedAt: 10 }
  ], {
    projectId: 'project-a',
    path: 'resources/older.md',
    openedAt: 30
  })

  assert.deepEqual(touched, [
    { projectId: 'project-a', path: 'resources/older.md', openedAt: 30 },
    { projectId: 'project-a', path: 'resources/newer.md', openedAt: 20 }
  ])
})

test('recent literature is validated, de-duplicated by id, sorted, and bounded', () => {
  const parsed = sanitizeRecentLiterature([
    { id: 'lit-a', openedAt: 1 },
    { id: 'lit-a', openedAt: 99 },
    ...Array.from({ length: MAX_TRACKED_RECENT_LITERATURE + 5 }, (_, index) => ({
      id: `lit-${index}`,
      openedAt: index + 2
    })),
    { id: '', openedAt: 200 },
    { id: 'lit-b', openedAt: 'now' },
    { id: 'lit-c' }
  ])

  assert.equal(parsed.length, MAX_TRACKED_RECENT_LITERATURE)
  assert.deepEqual(parsed[0], { id: 'lit-a', openedAt: 99 })
  assert.equal(parsed.filter((entry) => entry.id === 'lit-a').length, 1)
  assert.ok(parsed.every((entry, index) => index === 0 || parsed[index - 1].openedAt >= entry.openedAt))
  assert.deepEqual(sanitizeRecentLiterature('not a list'), [])
})

test('touching an existing recent literature moves it to the front without duplicating it', () => {
  const touched = touchRecentLiterature([
    { id: 'lit-newer', openedAt: 20 },
    { id: 'lit-older', openedAt: 10 }
  ], { id: 'lit-older', openedAt: 30 })

  assert.deepEqual(touched, [
    { id: 'lit-older', openedAt: 30 },
    { id: 'lit-newer', openedAt: 20 }
  ])
  assert.ok(recentLiteratureEqual(touched, touched))
  assert.equal(recentLiteratureEqual(touched, [{ id: 'lit-newer', openedAt: 20 }, { id: 'lit-older', openedAt: 30 }]), false)
})

test('renderer preferences sanitize and compare the recent literature list', () => {
  const parsed = sanitizeRendererPreferences({
    recentLiterature: [{ id: 'lit-a', openedAt: 7 }]
  })
  assert.deepEqual(parsed.recentLiterature, [{ id: 'lit-a', openedAt: 7 }])
  assert.equal(
    recentLiteratureEqual(parsed.recentLiterature, DEFAULT_RENDERER_PREFERENCES.recentLiterature),
    false
  )
})

test('recent sessions are validated, de-duplicated, sorted, bounded, and persisted', () => {
  const parsed = sanitizeRecentSessions([
    { id: 'session-a', openedAt: 1 },
    { id: 'session-a', openedAt: 99 },
    ...Array.from({ length: MAX_TRACKED_RECENT_SESSIONS + 5 }, (_, index) => ({
      id: `session-${index}`,
      openedAt: index + 2
    })),
    { id: '', openedAt: 200 },
    { id: 'session-b', openedAt: 'now' }
  ])
  assert.equal(parsed.length, MAX_TRACKED_RECENT_SESSIONS)
  assert.deepEqual(parsed[0], { id: 'session-a', openedAt: 99 })

  const touched = touchRecentSession(parsed, { id: 'session-older', openedAt: 300 })
  assert.deepEqual(touched[0], { id: 'session-older', openedAt: 300 })
  assert.ok(recentSessionsEqual(touched, touched))

  const preferences = sanitizeRendererPreferences({ recentSessions: touched })
  assert.deepEqual(preferences.recentSessions, touched)
})
