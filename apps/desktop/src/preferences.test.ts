import assert from 'node:assert/strict'
import test from 'node:test'
import { defaultSelectionPrompts } from './prompts.ts'

import {
  DEFAULT_RENDERER_PREFERENCES,
  MAX_TRACKED_RECENT_FILES,
  MAX_TRACKED_RECENT_LITERATURE,
  MAX_TRACKED_RECENT_SESSIONS,
  MAX_MODEL_KEY_LENGTH,
  defaultRendererPreferences,
  rendererLanguagePatch,
  systemRendererPreferences,
  SYSTEM_LANGUAGE_MODE,
  rendererPreferencesEqual,
  sanitizeRecentFiles,
  sanitizeRecentLiterature,
  sanitizeRecentSessions,
  sanitizeRendererPreferences,
  sanitizeLiteratureAiModels,
  recentLiteratureEqual,
  recentSessionsEqual,
  touchRecentFile,
  touchRecentLiterature,
  touchRecentSession,
} from './preferences.ts'

test('cleared task message versions survive preference round trips and participate in equality', () => {
  const key = JSON.stringify(['imports', 'completed-task'])
  const preferences = sanitizeRendererPreferences({ taskMessageDismissals: { [key]: 7 } })
  assert.deepEqual(preferences.taskMessageDismissals, { [key]: 7 })
  assert.deepEqual(
    sanitizeRendererPreferences(JSON.parse(JSON.stringify(preferences))).taskMessageDismissals,
    { [key]: 7 }
  )
  assert.equal(rendererPreferencesEqual(preferences, sanitizeRendererPreferences({})), false)
  assert.deepEqual(
    sanitizeRendererPreferences({
      taskMessageDismissals: { valid: 0, negative: -1, text: '2', fraction: 1.5 },
    }).taskMessageDismissals,
    { valid: 0 }
  )
})

test('external browser automation defaults on and preserves explicit saved choices', () => {
  assert.equal(defaultRendererPreferences().browserAutomationEnabled, true)
  assert.equal(sanitizeRendererPreferences({ theme: 'dark' }).browserAutomationEnabled, true)
  for (const invalid of [null, 'true', 1])
    assert.equal(
      sanitizeRendererPreferences({ browserAutomationEnabled: invalid }).browserAutomationEnabled,
      false
    )
  for (const enabled of [false, true]) {
    const preferences = sanitizeRendererPreferences({ browserAutomationEnabled: enabled })
    assert.equal(preferences.browserAutomationEnabled, enabled)
    assert.equal(
      sanitizeRendererPreferences(JSON.parse(JSON.stringify(preferences))).browserAutomationEnabled,
      enabled
    )
    assert.equal(
      rendererPreferencesEqual(
        preferences,
        sanitizeRendererPreferences({ browserAutomationEnabled: !enabled })
      ),
      false
    )
  }
})

test('last page survives preference round trip without transient UI state', () => {
  const lastLocation = {
    view: 'resource',
    projectId: 'project-a',
    sessionId: 'session-a',
    sessionProjectId: 'project-a',
    settingsPage: 'skills',
    aiPanelOpen: true,
    aiPanelCover: false,
    target: {
      kind: 'document',
      viewKind: 'edit',
      title: 'note.md',
      source: { kind: 'project', project: 'project-a', path: 'resources/note.md' },
    },
  }
  const preferences = sanitizeRendererPreferences({ lastLocation, loginOpen: true })
  const migratedLocation = { ...lastLocation, browserSettingsSection: null }
  assert.deepEqual(preferences.lastLocation, migratedLocation)
  assert.deepEqual(
    sanitizeRendererPreferences(JSON.parse(JSON.stringify(preferences))).lastLocation,
    migratedLocation
  )
  assert.equal('loginOpen' in preferences, false)
  assert.equal(rendererPreferencesEqual(preferences, sanitizeRendererPreferences({})), false)
})

test('old and invalid preferences have no saved location', () => {
  assert.equal(sanitizeRendererPreferences({}).lastLocation, null)
  assert.equal(
    sanitizeRendererPreferences({ lastLocation: { view: 'removed-page' } }).lastLocation,
    null
  )
})

test('literature AI model preferences keep only known actions and valid model keys', () => {
  assert.deepEqual(
    sanitizeLiteratureAiModels({
      document_translation: 'qwen3.8-max',
      interpretation: 'personal-profile:gpt-5.6-sol',
      figure_explanation: 'qwen-vl-max',
      selection_translation: 'qwen3.8-max',
      selection_explanation: 'personal-profile:explain-model',
      unknown: 'ignored',
    }),
    {
      document_translation: 'qwen3.8-max',
      selection_translation: 'qwen3.8-max',
      selection_explanation: 'personal-profile:explain-model',
      interpretation: 'personal-profile:gpt-5.6-sol',
      figure_explanation: 'qwen-vl-max',
    }
  )
  assert.deepEqual(
    sanitizeLiteratureAiModels({
      document_translation: '',
      interpretation: 'x'.repeat(MAX_MODEL_KEY_LENGTH + 1),
      figure_explanation: 42,
    }),
    {}
  )
  assert.deepEqual(
    sanitizeRendererPreferences({
      literatureAiModels: { interpretation: 'gpt-5.6-sol' },
    }).literatureAiModels,
    { interpretation: 'gpt-5.6-sol' }
  )
})

test('selection explanation model survives preference serialization independently of translation', () => {
  const preferences = sanitizeRendererPreferences({
    literatureAiModels: {
      selection_explanation: 'personal:explain',
      selection_translation: 'builtin:translate',
    },
  })
  const restored = sanitizeRendererPreferences(JSON.parse(JSON.stringify(preferences)))
  assert.equal(restored.literatureAiModels.selection_explanation, 'personal:explain')
  assert.equal(restored.literatureAiModels.selection_translation, 'builtin:translate')
})

test('notification preferences persist while privacy mode remains fail-closed', () => {
  const parsed = sanitizeRendererPreferences({
    sidebarOpen: false,
    sessionActivityInitialized: true,
    sessionActivitySeen: { session: 12 },
    desktopNotifications: false,
    soundAlerts: false,
    dataSharingMode: 'improve',
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
      invalidShiftText: { key: 'A', modifiers: ['shift'] },
    },
  })
  assert.deepEqual(parsed.shortcutOverrides, {
    'markdown.bold': { key: 'm', modifiers: ['primary', 'shift'] },
    'pdf.nextPage': { key: 'PageDown', modifiers: [] },
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

test('defaultRendererPreferences seeds the initial language and prompts without mutating the exported constant', () => {
  const detected = defaultRendererPreferences('en')
  assert.equal(detected.language, 'en')
  assert.deepEqual(detected, {
    ...DEFAULT_RENDERER_PREFERENCES,
    language: 'en',
    selectionPrompts: defaultSelectionPrompts('en'),
  })

  assert.deepEqual(defaultRendererPreferences(), DEFAULT_RENDERER_PREFERENCES)
  assert.deepEqual(defaultRendererPreferences('zh'), DEFAULT_RENDERER_PREFERENCES)

  // 兜底语言是检测链的最终结果，常量本身必须保持中文不动。
  assert.equal(DEFAULT_RENDERER_PREFERENCES.language, 'zh')
  assert.notEqual(detected, DEFAULT_RENDERER_PREFERENCES)
})

test('fixed locale snapshots and fresh profiles preserve distinct language intent', () => {
  const fixed = defaultRendererPreferences('en')
  const following = systemRendererPreferences('en')
  assert.equal(sanitizeRendererPreferences(fixed, 'zh').language, 'en')
  assert.equal(sanitizeRendererPreferences(following, 'zh').language, 'zh')
  assert.equal(following.languageMode, SYSTEM_LANGUAGE_MODE)

  const pinned = { ...following, ...rendererLanguagePatch('en') }
  assert.deepEqual(sanitizeRendererPreferences(pinned, 'zh'), sanitizeRendererPreferences(fixed))
  assert.equal(
    sanitizeRendererPreferences({ ...pinned, ...rendererLanguagePatch(SYSTEM_LANGUAGE_MODE) }, 'zh')
      .language,
    'zh'
  )
})

test('recent files are validated, de-duplicated by project and path, sorted, and bounded', () => {
  const parsed = sanitizeRecentFiles([
    { projectId: 'project-a', path: 'resources/duplicate.md', openedAt: 1 },
    { projectId: 'project-a', path: 'resources/duplicate.md', openedAt: 99 },
    { projectId: 'project-b', path: 'resources/duplicate.md', openedAt: 98 },
    ...Array.from({ length: MAX_TRACKED_RECENT_FILES + 5 }, (_, index) => ({
      projectId: 'project-a',
      path: `resources/file-${index}.md`,
      openedAt: index + 2,
    })),
    { projectId: '', path: 'resources/missing-project.md', openedAt: 200 },
    { projectId: 'project-a', path: '', openedAt: 200 },
    { projectId: 'project-a', path: 'resources/not-a-time.md', openedAt: 'now' },
  ])

  assert.equal(parsed.length, MAX_TRACKED_RECENT_FILES)
  assert.deepEqual(parsed[0], {
    projectId: 'project-a',
    path: 'resources/duplicate.md',
    openedAt: 99,
  })
  assert.equal(parsed.filter((entry) => entry.path === 'resources/duplicate.md').length, 2)
  assert.ok(
    parsed.every((entry, index) => index === 0 || parsed[index - 1].openedAt >= entry.openedAt)
  )
})

test('touching an existing recent file moves it to the front without duplicating it', () => {
  const touched = touchRecentFile(
    [
      { projectId: 'project-a', path: 'resources/newer.md', openedAt: 20 },
      { projectId: 'project-a', path: 'resources/older.md', openedAt: 10 },
    ],
    {
      projectId: 'project-a',
      path: 'resources/older.md',
      openedAt: 30,
    }
  )

  assert.deepEqual(touched, [
    { projectId: 'project-a', path: 'resources/older.md', openedAt: 30 },
    { projectId: 'project-a', path: 'resources/newer.md', openedAt: 20 },
  ])
})

test('recent literature is validated, de-duplicated by id, sorted, and bounded', () => {
  const parsed = sanitizeRecentLiterature([
    { id: 'lit-a', openedAt: 1 },
    { id: 'lit-a', openedAt: 99 },
    ...Array.from({ length: MAX_TRACKED_RECENT_LITERATURE + 5 }, (_, index) => ({
      id: `lit-${index}`,
      openedAt: index + 2,
    })),
    { id: '', openedAt: 200 },
    { id: 'lit-b', openedAt: 'now' },
    { id: 'lit-c' },
  ])

  assert.equal(parsed.length, MAX_TRACKED_RECENT_LITERATURE)
  assert.deepEqual(parsed[0], { id: 'lit-a', openedAt: 99 })
  assert.equal(parsed.filter((entry) => entry.id === 'lit-a').length, 1)
  assert.ok(
    parsed.every((entry, index) => index === 0 || parsed[index - 1].openedAt >= entry.openedAt)
  )
  assert.deepEqual(sanitizeRecentLiterature('not a list'), [])
})

test('touching an existing recent literature moves it to the front without duplicating it', () => {
  const touched = touchRecentLiterature(
    [
      { id: 'lit-newer', openedAt: 20 },
      { id: 'lit-older', openedAt: 10 },
    ],
    { id: 'lit-older', openedAt: 30 }
  )

  assert.deepEqual(touched, [
    { id: 'lit-older', openedAt: 30 },
    { id: 'lit-newer', openedAt: 20 },
  ])
  assert.ok(recentLiteratureEqual(touched, touched))
  assert.equal(
    recentLiteratureEqual(touched, [
      { id: 'lit-newer', openedAt: 20 },
      { id: 'lit-older', openedAt: 30 },
    ]),
    false
  )
})

test('renderer preferences sanitize and compare the recent literature list', () => {
  const parsed = sanitizeRendererPreferences({
    recentLiterature: [{ id: 'lit-a', openedAt: 7 }],
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
      openedAt: index + 2,
    })),
    { id: '', openedAt: 200 },
    { id: 'session-b', openedAt: 'now' },
  ])
  assert.equal(parsed.length, MAX_TRACKED_RECENT_SESSIONS)
  assert.deepEqual(parsed[0], { id: 'session-a', openedAt: 99 })

  const touched = touchRecentSession(parsed, { id: 'session-older', openedAt: 300 })
  assert.deepEqual(touched[0], { id: 'session-older', openedAt: 300 })
  assert.ok(recentSessionsEqual(touched, touched))

  const preferences = sanitizeRendererPreferences({ recentSessions: touched })
  assert.deepEqual(preferences.recentSessions, touched)
})

test('recent project survives restarts independently of the current global page', () => {
  const stored = sanitizeRendererPreferences({ recentProjectId: 'project', lastLocation: null })
  assert.equal(stored.recentProjectId, 'project')
  assert.equal(
    sanitizeRendererPreferences(JSON.parse(JSON.stringify(stored))).recentProjectId,
    'project'
  )
  assert.equal(rendererPreferencesEqual(stored, { ...stored, recentProjectId: 'other' }), false)
  assert.equal(sanitizeRendererPreferences({ recentProjectId: 7 }).recentProjectId, null)
})

test('automatic update download defaults on and persists an explicit opt out', () => {
  const defaults = defaultRendererPreferences()
  assert.equal(defaults.autoDownloadUpdates, true)
  const disabled = sanitizeRendererPreferences({ ...defaults, autoDownloadUpdates: false })
  assert.equal(disabled.autoDownloadUpdates, false)
  assert.equal(rendererPreferencesEqual(defaults, disabled), false)
  assert.deepEqual(sanitizeRendererPreferences(JSON.parse(JSON.stringify(disabled))), disabled)
  assert.equal(
    sanitizeRendererPreferences({ autoDownloadUpdates: 'false' }).autoDownloadUpdates,
    true
  )
})
