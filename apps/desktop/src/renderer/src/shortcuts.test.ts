import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  SHORTCUTS,
  effectiveShortcutBindings,
  findShortcutConflicts,
  formatShortcut,
  matchesShortcut,
  recordShortcutBinding,
  resolveMarkdownShortcut,
  resolveShortcut,
  shortcutBinding,
  shortcutBindings,
  suppressMarkdownDefaultShortcut,
  type ShortcutEvent,
  type ShortcutOverrides
} from './shortcuts.ts'

const commandEvent = (
  key: string,
  overrides: Partial<ShortcutEvent> = {}
): ShortcutEvent => ({
  altKey: false,
  ctrlKey: false,
  key,
  metaKey: true,
  shiftKey: false,
  ...overrides
})

test('shortcut catalog has unique command ids and no same-scope binding conflicts', () => {
  assert.equal(new Set(SHORTCUTS.map(shortcut => shortcut.id)).size, SHORTCUTS.length)
  const scopedBindings = SHORTCUTS.flatMap(shortcut => shortcut.bindings.map(binding => (
    `${shortcut.scope}:${[...binding.modifiers].sort().join('+')}:${binding.key.toLocaleLowerCase()}`
  )))
  assert.equal(new Set(scopedBindings).size, scopedBindings.length)
})

test('Markdown shortcut catalog covers the approved editing commands only', () => {
  const markdownIds = SHORTCUTS
    .filter(shortcut => shortcut.scope === 'markdown')
    .map(shortcut => shortcut.id)
  assert.deepEqual(markdownIds, [
    'markdown.save',
    'markdown.undo',
    'markdown.redo',
    'markdown.find',
    'markdown.selectAll',
    'markdown.bold',
    'markdown.italic',
    'markdown.strikethrough',
    'markdown.inlineCode',
    'markdown.link',
    'markdown.paragraph',
    'markdown.heading1',
    'markdown.heading2',
    'markdown.heading3',
    'markdown.heading4',
    'markdown.heading5',
    'markdown.heading6'
  ])
  assert.equal(markdownIds.some(id => /quote|list|codeBlock/i.test(id)), false)
})

test('code shortcut catalog covers the approved editor commands', () => {
  assert.deepEqual(
    SHORTCUTS.filter(shortcut => shortcut.scope === 'code').map(shortcut => shortcut.id),
    [
      'code.save',
      'code.saveAll',
      'code.quickOpen',
      'code.undo',
      'code.redo',
      'code.find',
      'code.replace',
      'code.copyLineUp',
      'code.copyLineDown',
      'code.moveLineUp',
      'code.moveLineDown',
      'code.deleteLine',
      'code.goToLine',
      'code.lineComment',
      'code.blockComment',
      'code.indent',
      'code.outdent'
    ]
  )
})

test('PDF shortcut catalog covers navigation, zoom, browsing, and unassigned annotation actions', () => {
  const pdf = SHORTCUTS.filter(shortcut => shortcut.scope === 'pdf')
  assert.deepEqual(pdf.map(shortcut => shortcut.id), [
    'pdf.find', 'pdf.findNext', 'pdf.findPrevious',
    'pdf.previousPage', 'pdf.nextPage', 'pdf.firstPage', 'pdf.lastPage', 'pdf.goToPage',
    'pdf.zoomIn', 'pdf.zoomOut', 'pdf.actualSize',
    'pdf.scrollUp', 'pdf.scrollDown', 'pdf.scrollLeft', 'pdf.scrollRight',
    'pdf.scrollPageDown', 'pdf.scrollPageUp',
    'pdf.highlight', 'pdf.comment', 'pdf.copyText', 'pdf.openLink', 'pdf.toggleOutline'
  ])
  for (const id of ['pdf.highlight', 'pdf.comment', 'pdf.copyText', 'pdf.openLink', 'pdf.toggleOutline'] as const) {
    assert.deepEqual(shortcutBindings(id), [])
  }
})

test('global shortcut commands have no product-defined bindings', () => {
  const globalShortcuts = SHORTCUTS.filter(shortcut => shortcut.scope === 'global')
  assert.ok(globalShortcuts.length > 0)
  for (const shortcut of globalShortcuts) assert.deepEqual(shortcut.bindings, [])
})

test('shortcut display uses native primary modifier labels', () => {
  const binding = shortcutBinding('workbench.toggleModulePanel')
  assert.equal(formatShortcut(binding, 'mac'), '⌘B')
  assert.equal(formatShortcut(binding, 'windows'), 'Ctrl+B')
  assert.equal(formatShortcut(shortcutBinding('code.redo'), 'mac'), '⇧⌘Z')
  assert.equal(formatShortcut(shortcutBinding('code.redo'), 'windows'), 'Ctrl+Shift+Z')
})

test('shortcut matching uses the platform primary modifier and supports alternate bindings', () => {
  assert.equal(matchesShortcut(commandEvent('b'), 'markdown.bold', 'mac'), true)
  assert.equal(matchesShortcut(commandEvent('B', { metaKey: false, ctrlKey: true } as Partial<ShortcutEvent>), 'markdown.bold', 'windows'), true)
  assert.equal(matchesShortcut(commandEvent('b', { metaKey: false, ctrlKey: true }), 'markdown.bold', 'mac'), false)
  assert.equal(matchesShortcut(commandEvent('b', { shiftKey: true }), 'markdown.bold', 'mac'), false)
  assert.equal(shortcutBindings('office.redo').length, 2)
  assert.equal(matchesShortcut(commandEvent('y'), 'office.redo', 'mac'), true)
})

test('active editor scope wins over workbench for the same binding', () => {
  assert.equal(
    resolveShortcut(commandEvent('b'), ['markdown', 'global'], 'mac')?.id,
    'markdown.bold'
  )
  assert.equal(
    resolveShortcut(commandEvent('b'), ['workbench', 'global'], 'mac')?.id,
    'workbench.toggleModulePanel'
  )
})

test('an active editor never falls through to workbench commands after rebinding or clearing', () => {
  const rebound: ShortcutOverrides = {
    'markdown.bold': { key: 'p', modifiers: ['primary', 'shift'] }
  }
  assert.equal(resolveShortcut(commandEvent('b'), ['markdown', 'global'], 'mac', rebound), undefined)
  assert.equal(resolveShortcut(commandEvent('b'), ['markdown', 'global'], 'mac', { 'markdown.bold': null }), undefined)
})

test('Markdown resolves effective bindings while suppressing displaced native defaults', () => {
  const rebound: ShortcutOverrides = {
    'markdown.italic': { key: 'p', modifiers: ['primary', 'shift'] }
  }
  assert.equal(resolveMarkdownShortcut(commandEvent('p', { shiftKey: true }), 'mac', rebound)?.id, 'markdown.italic')
  assert.equal(resolveMarkdownShortcut(commandEvent('i'), 'mac', rebound), undefined)
  assert.equal(suppressMarkdownDefaultShortcut(commandEvent('i'), 'mac'), true)
  assert.equal(suppressMarkdownDefaultShortcut(commandEvent('e'), 'mac'), true)
  assert.equal(suppressMarkdownDefaultShortcut(commandEvent('x', { altKey: true }), 'mac'), true)
  assert.equal(suppressMarkdownDefaultShortcut(commandEvent('2', { altKey: true }), 'mac'), true)
  assert.equal(suppressMarkdownDefaultShortcut(commandEvent('y'), 'mac'), true)
  assert.equal(suppressMarkdownDefaultShortcut(commandEvent('y', { metaKey: false, ctrlKey: true }), 'windows'), true)
  assert.equal(suppressMarkdownDefaultShortcut(commandEvent('7', { altKey: true }), 'mac'), false)
  assert.equal(suppressMarkdownDefaultShortcut(commandEvent('Enter'), 'mac'), false)
})

test('user overrides replace defaults, clearing disables, and deleting the override restores defaults', () => {
  const rebound: ShortcutOverrides = {
    'markdown.bold': { key: 'm', modifiers: ['primary', 'shift'] }
  }
  assert.deepEqual(effectiveShortcutBindings('markdown.bold', rebound), [
    { key: 'm', modifiers: ['primary', 'shift'] }
  ])
  assert.equal(matchesShortcut(commandEvent('b'), 'markdown.bold', 'mac', rebound), false)
  assert.equal(matchesShortcut(commandEvent('m', { shiftKey: true }), 'markdown.bold', 'mac', rebound), true)
  assert.deepEqual(effectiveShortcutBindings('markdown.bold', { 'markdown.bold': null }), [])
  assert.equal(matchesShortcut(commandEvent('b'), 'markdown.bold', 'mac', { 'markdown.bold': null }), false)
  assert.equal(matchesShortcut(commandEvent('b'), 'markdown.bold', 'mac', {}), true)
})

test('same-scope effective bindings conflict while cross-scope reuse remains valid', () => {
  const binding = { key: 's', modifiers: ['primary'] } as const
  assert.deepEqual(
    findShortcutConflicts('markdown.bold', binding, {}),
    ['markdown.save']
  )
  assert.deepEqual(
    findShortcutConflicts('workbench.toggleModulePanel', binding, {}),
    []
  )
})

test('shortcut recording rejects unsafe bare keys and reserved combinations', () => {
  assert.deepEqual(
    recordShortcutBinding(commandEvent('p', { shiftKey: true }), 'mac'),
    { key: 'p', modifiers: ['primary', 'shift'] }
  )
  assert.equal(recordShortcutBinding(commandEvent('p', { metaKey: false }), 'mac'), undefined)
  assert.equal(recordShortcutBinding(commandEvent('Shift', { shiftKey: true }), 'mac'), undefined)
  assert.equal(recordShortcutBinding(commandEvent('q'), 'mac'), undefined)
  assert.deepEqual(
    recordShortcutBinding(commandEvent('p', { metaKey: false, ctrlKey: true }), 'windows'),
    { key: 'p', modifiers: ['primary'] }
  )
})

test('shortcut recording supports editor modifiers and safe bare navigation keys', () => {
  assert.deepEqual(
    recordShortcutBinding(commandEvent('ArrowUp', { altKey: true, metaKey: false }), 'mac'),
    { key: 'ArrowUp', modifiers: ['alt'] }
  )
  assert.deepEqual(
    recordShortcutBinding(commandEvent('PageDown', { metaKey: false }), 'mac'),
    { key: 'PageDown', modifiers: [] }
  )
  assert.deepEqual(
    recordShortcutBinding(commandEvent('Tab', { metaKey: false, shiftKey: true }), 'mac'),
    { key: 'Tab', modifiers: ['shift'] }
  )
  assert.equal(recordShortcutBinding(commandEvent('a', { metaKey: false }), 'mac'), undefined)
  assert.equal(recordShortcutBinding(commandEvent('A', { metaKey: false, shiftKey: true }), 'mac'), undefined)
  assert.equal(formatShortcut({ key: 'ArrowDown', modifiers: ['alt'] }, 'mac'), '⌥↓')
  assert.equal(formatShortcut({ key: 'ArrowDown', modifiers: ['alt'] }, 'windows'), 'Alt+↓')
  assert.equal(formatShortcut({ key: '+', modifiers: ['primary', 'shift'] }, 'mac'), '⌘+')
  assert.equal(formatShortcut({ key: '+', modifiers: ['primary', 'shift'] }, 'windows'), 'Ctrl++')
})

test('runtime consumers use the shared shortcut registry', () => {
  const source = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
  assert.match(source('./shell/WorkbenchShell.tsx'), /resolveShortcut/)
  assert.match(source('./shell/WorkbenchShell.tsx'), /event\.defaultPrevented/)
  const markdown = source('./features/workbench/MarkdownDocument.tsx')
  assert.match(markdown, /resolveMarkdownShortcut/)
  assert.match(markdown, /suppressMarkdownDefaultShortcut/)
  assert.match(source('./features/workbench/MonacoDocument.tsx'), /monacoShortcut/)
  assert.match(source('./features/workbench/MonacoDocument.tsx'), /editor\.action\.gotoLine/)
  assert.match(source('./features/workbench/MonacoDocument.tsx'), /globalSearchMode: 'files'/)
  assert.match(source('./features/workbench/PdfDocument.tsx'), /pdf\.find/)
  assert.match(source('./features/workbench/OfficeDocument.tsx'), /office\.find/)
  assert.match(source('./features/workbench/office/frame.ts'), /effectiveShortcutBindings/)
  assert.doesNotMatch(source('./features/workbench/office/input.js'), /const SHORTCUTS/)
})

test('settings page edits, clears, and restores runtime shortcut overrides', () => {
  const page = readFileSync(new URL('./components/business/Shortcuts.tsx', import.meta.url), 'utf8')
  const panel = readFileSync(new URL('./components/business/AccountPanel.tsx', import.meta.url), 'utf8')
  assert.match(page, /SHORTCUTS/)
  assert.match(page, /formatShortcut/)
  assert.match(page, /<SearchBox/)
  assert.match(page, /<kbd/)
  assert.match(page, /recordShortcutBinding/)
  assert.match(page, /findShortcutConflicts/)
  assert.match(page, /clearShortcutOverride/)
  assert.match(page, /resetShortcutOverride/)
  assert.match(page, /<Dialog/)
  assert.match(panel, /id: 'shortcuts'/)
  assert.match(panel, /activePage === 'shortcuts' && <Shortcuts/)
})

test('shortcut message catalog is complete in both product languages', () => {
  const messages = ['zh', 'en'].map(language => JSON.parse(readFileSync(
    new URL(`../../localization/locales/${language}/shortcuts.json`, import.meta.url),
    'utf8'
  )) as { commands: Record<string, { description: string; title: string }> })
  const expected = [...new Set(SHORTCUTS.map(shortcut => shortcut.messageKey))].sort()
  for (const message of messages) {
    assert.deepEqual(Object.keys(message.commands).sort(), expected)
    for (const command of Object.values(message.commands)) {
      assert.ok(command.title.trim())
      assert.ok(command.description.trim())
    }
  }
})
