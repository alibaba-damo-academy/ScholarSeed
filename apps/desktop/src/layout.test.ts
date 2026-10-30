import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_PROJECT_LAYOUT,
  projectLayoutTransition,
  projectLayoutsEqual,
  sanitizeProjectLayouts,
  changeProjectLayout,
} from './layout.ts'
import {
  DEFAULT_RENDERER_PREFERENCES,
  rendererPreferencesEqual,
  sanitizeRendererPreferences,
} from './preferences.ts'

const initial = () => ({
  homeSelectedProjectId: null as string | null,
  workbenchLayout: { ...DEFAULT_PROJECT_LAYOUT },
  projectLayouts: {},
})

test('showing a task selects its full workspace tab and preserves document layout preferences', () => {
  for (const full of [false, true]) {
    for (const floating of ['compact', 'expanded', 'minimized'] as const) {
      const layout = {
        ...DEFAULT_PROJECT_LAYOUT,
        open: true,
        full,
        swapped: true,
        floating,
        conversationWidth: 420,
      }
      assert.deepEqual(changeProjectLayout(layout, 'showTask'), {
        ...layout,
        taskTab: full,
        floating: floating === 'minimized' ? layout.floatingRestore : floating,
      })
      assert.equal(changeProjectLayout(layout, 'showTask').full, full)
    }
  }
})

test('conversation width defaults to 360 pixels and has independent persisted ownership', () => {
  assert.equal(DEFAULT_PROJECT_LAYOUT.conversationWidth, 360)
  const layouts = sanitizeProjectLayouts({
    legacy: { open: true, width: '50%' },
    resized: { conversationWidth: 420 },
    percentage: { conversationWidth: '60%' },
  })
  assert.equal(layouts.legacy.conversationWidth, 360)
  assert.equal(layouts.legacy.open, true)
  assert.equal(layouts.resized.conversationWidth, 420)
  assert.equal(layouts.percentage.conversationWidth, 360)
  const preferences = sanitizeRendererPreferences({ projectLayouts: layouts })
  assert.deepEqual(preferences.projectLayouts, layouts)
})

test('entering floating mode starts compact and preserves explicit expansion and restoration', () => {
  const floating = changeProjectLayout(DEFAULT_PROJECT_LAYOUT, 'pinConversation')
  assert.equal(floating.floating, 'compact')
  const expanded = changeProjectLayout(floating, 'toggleFloating')
  assert.equal(expanded.floating, 'expanded')
  const minimized = changeProjectLayout(expanded, 'minimizeConversation')
  assert.equal(changeProjectLayout(minimized, 'restoreConversation').floating, 'expanded')
})

test('moving a conversation right restores split mode without opening a closed workspace', () => {
  const closed = changeProjectLayout(DEFAULT_PROJECT_LAYOUT, 'moveConversationRight')
  assert.equal(closed.open, false)
  const floating = changeProjectLayout(DEFAULT_PROJECT_LAYOUT, 'pinConversation')
  const moved = changeProjectLayout(floating, 'moveConversationRight')
  assert.equal(moved.open, true)
  assert.equal(moved.swapped, true)
  assert.equal(moved.full, false)
  assert.equal(moved.conversationFull, false)
  assert.equal(moved.taskTab, false)
})

test('moving a conversation left restores split mode and preserves workspace visibility', () => {
  for (const open of [false, true]) {
    const layout = {
      ...DEFAULT_PROJECT_LAYOUT,
      open,
      swapped: true,
      full: true,
      conversationFull: true,
      taskTab: true,
    }
    const moved = changeProjectLayout(layout, 'moveConversationLeft')
    assert.equal(moved.open, open)
    assert.equal(moved.swapped, false)
    assert.equal(moved.full, false)
    assert.equal(moved.conversationFull, false)
    assert.equal(moved.taskTab, false)
    assert.equal(changeProjectLayout(moved, 'moveConversationRight').swapped, true)
  }
})

test('conversation fullscreen is independent of workspace fullscreen and restores its previous mode', () => {
  const pinned = changeProjectLayout(DEFAULT_PROJECT_LAYOUT, 'pinConversation')
  const fullscreen = changeProjectLayout(pinned, 'toggleConversationFull')
  assert.equal(fullscreen.conversationFull, true)
  assert.equal(changeProjectLayout(fullscreen, 'toggleConversationFull').conversationFull, false)
  assert.equal(changeProjectLayout(fullscreen, 'toggleConversationFull').floating, pinned.floating)
  const compact = pinned
  assert.equal(compact.floating, 'compact')
  const minimized = changeProjectLayout(compact, 'minimizeConversation')
  assert.equal(minimized.floating, 'minimized')
  assert.equal(changeProjectLayout(minimized, 'restoreConversation').floating, 'compact')
  assert.equal(changeProjectLayout(fullscreen, 'toggleWorkspace').conversationFull, false)
})

test('workspace toggles recover split view from floating and task tab modes', () => {
  for (const taskTab of [false, true]) {
    const layout = { ...DEFAULT_PROJECT_LAYOUT, open: true, full: true, taskTab }
    const closed = changeProjectLayout(layout, 'toggleWorkspace')
    assert.equal(closed.open, false)
    assert.equal(closed.full, false)
    assert.equal(closed.taskTab, false)
    assert.equal(changeProjectLayout(closed, 'toggleWorkspace').open, true)
  }
})

test('pinning back restores the conversation layout according to workspace visibility', () => {
  const layout = { ...DEFAULT_PROJECT_LAYOUT, conversationWidth: 420, swapped: true }
  const floating = changeProjectLayout(layout, 'pinConversation')
  assert.equal(floating.open, true)
  assert.equal(floating.full, true)
  assert.equal(floating.taskTab, false)
  assert.equal(floating.floating, 'compact')
  for (const open of [false, true]) {
    const docked = changeProjectLayout(
      { ...floating, open, conversationFull: true },
      'pinConversation'
    )
    assert.equal(docked.open, open)
    assert.equal(docked.full, false)
    assert.equal(docked.taskTab, false)
    assert.equal(docked.conversationFull, false)
    assert.equal(docked.conversationWidth, layout.conversationWidth)
    assert.equal(docked.swapped, layout.swapped)
  }
})

test('new projects open only the conversation and never inherit another project layout', () => {
  const first = projectLayoutTransition(initial(), { ...initial(), homeSelectedProjectId: 'first' })
  const edited = projectLayoutTransition(first, {
    ...first,
    workbenchLayout: {
      ...first.workbenchLayout,
      open: true,
      swapped: true,
      conversationWidth: 420,
    },
  })
  const second = projectLayoutTransition(edited, { ...edited, homeSelectedProjectId: 'second' })
  assert.deepEqual(second.workbenchLayout, DEFAULT_PROJECT_LAYOUT)
  const restored = projectLayoutTransition(second, { ...second, homeSelectedProjectId: 'first' })
  assert.deepEqual(restored.workbenchLayout, edited.workbenchLayout)
})

test('closing and full screen state survive project switching and preference round trips', () => {
  const first = { ...initial(), homeSelectedProjectId: 'first' }
  const edited = projectLayoutTransition(first, {
    ...first,
    workbenchLayout: {
      ...first.workbenchLayout,
      open: false,
      full: true,
      floating: 'expanded' as const,
    },
  })
  const preferences = sanitizeRendererPreferences(
    JSON.parse(
      JSON.stringify({
        ...DEFAULT_RENDERER_PREFERENCES,
        projectLayouts: edited.projectLayouts,
      })
    )
  )
  const restarted = { ...initial(), projectLayouts: preferences.projectLayouts! }
  assert.deepEqual(
    projectLayoutTransition(restarted, {
      ...restarted,
      homeSelectedProjectId: 'first',
    }).workbenchLayout,
    edited.workbenchLayout
  )
})

test('non-project surfaces do not create layout records', () => {
  const before = initial()
  const after = projectLayoutTransition(before, {
    ...before,
    workbenchLayout: { ...before.workbenchLayout, open: true },
  })
  assert.deepEqual(after.projectLayouts, {})
})

test('unchanged layout retains record identity', () => {
  const before = { ...initial(), homeSelectedProjectId: 'first' }
  assert.equal(projectLayoutTransition(before, { ...before }).projectLayouts, before.projectLayouts)
})

test('invalid stored layouts and widths fall back safely; finite pixel widths survive', () => {
  assert.deepEqual(sanitizeProjectLayouts([]), {})
  const parsed = sanitizeProjectLayouts({
    bad: null,
    invalid: { open: 'yes', conversationWidth: NaN },
    pixels: { conversationWidth: 421.5 },
    percent: { conversationWidth: '60%' },
    overflow: { conversationWidth: Infinity },
  })
  assert.equal(parsed.bad, undefined)
  assert.deepEqual(parsed.invalid, DEFAULT_PROJECT_LAYOUT)
  assert.equal(parsed.pixels.conversationWidth, 421.5)
  assert.equal(parsed.percent.conversationWidth, DEFAULT_PROJECT_LAYOUT.conversationWidth)
  assert.equal(parsed.overflow.conversationWidth, DEFAULT_PROJECT_LAYOUT.conversationWidth)
})

test('layout equality ignores record order and preferences detect layout changes', () => {
  const first = { ...DEFAULT_PROJECT_LAYOUT }
  const second = { ...first, swapped: true }
  assert.equal(projectLayoutsEqual({ first, second }, { second, first }), true)
  assert.equal(
    rendererPreferencesEqual(DEFAULT_RENDERER_PREFERENCES, {
      ...DEFAULT_RENDERER_PREFERENCES,
      projectLayouts: { first },
    }),
    false
  )
})
