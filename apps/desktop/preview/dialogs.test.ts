import assert from 'node:assert/strict'
import test from 'node:test'
import { PREVIEW_CATALOG } from './catalog.ts'
import { DIALOG_APPLICATIONS, dialogPages } from './dialogs.ts'
import { pdfeGuidance, pdfeNavigationPages, type PdfeTranslate } from './collaboration.ts'
import zh from './locales/zh.json' with { type: 'json' }
import en from './locales/en.json' with { type: 'json' }

test('dialog applications group reachable business flows and preserve original navigation', () => {
  const entries = PREVIEW_CATALOG.filter((page) => page.navigationGroup === 'dialogs')
  assert.equal(entries.length, DIALOG_APPLICATIONS.length)
  assert.ok(
    !entries.some((page) =>
      ['dialog-conversation-rewind', 'dialog-literature-attachment-copy'].includes(page.id)
    )
  )
  for (const identity of [
    'projects',
    'tasks',
    'conversation',
    'files',
    'documents',
    'versions',
    'literature',
    'organization',
    'skills',
    'settings',
    'feedback',
    'connectors',
  ]) {
    assert.ok(
      entries.some((page) => page.navigationCollection?.id === identity),
      identity
    )
  }
  assert.equal(
    PREVIEW_CATALOG.find((page) => page.id === 'surface-project-form')?.navigationGroup,
    undefined
  )
  assert.equal(
    PREVIEW_CATALOG.find((page) => page.id === 'page-literature')?.navigationGroup,
    undefined
  )
  assert.equal(
    PREVIEW_CATALOG.find((page) => page.id === 'dialog-projects')?.scenarios[0].id,
    'dialog-project-create'
  )
})

test('dialog projection neither changes original pages nor accepts hidden origins', () => {
  const originals = PREVIEW_CATALOG.filter((page) => !page.dialogOrigin)
  const before = JSON.stringify(originals)
  dialogPages(originals)
  assert.equal(JSON.stringify(originals), before)
  const hidden = originals.map((page) =>
    page.id === 'page-home' ? { ...page, navigation: 'hidden' as const } : page
  )
  assert.throws(() => dialogPages(hidden), /Unavailable dialog origin/)
})

test('each dialog application reuses an available source target with bilingual entry guidance', () => {
  for (const entry of PREVIEW_CATALOG.filter((page) => page.navigationGroup === 'dialogs')) {
    assert.ok(entry.dialogOrigin, entry.id)
    const origin = PREVIEW_CATALOG.find((page) => page.id === entry.dialogOrigin!.pageId)!
    assert.ok(origin && origin.availability !== 'hidden' && !origin.host, entry.id)
    assert.notEqual(origin.navigation, 'hidden', entry.id)
    assert.deepEqual(entry.target, origin.target, entry.id)
    assert.ok(
      origin.scenarios.some((scene) => scene.id === entry.dialogOrigin!.sceneId),
      entry.id
    )
    assert.ok(entry.navigationCollection, entry.id)
    for (const dictionary of [zh, en]) {
      const translate = ((key: keyof typeof zh) => dictionary[key]) as PdfeTranslate
      const guide = pdfeGuidance(entry, entry.scenarios[0], translate)
      assert.ok(guide.entry.length && guide.entry.every((text) => text.trim()), entry.id)
      assert.ok(guide.limitations.length, entry.id)
      assert.ok(
        pdfeNavigationPages(
          PREVIEW_CATALOG,
          translate(entry.navigationCollection!.titleKey),
          translate
        ).includes(entry),
        entry.id
      )
      assert.ok(
        pdfeNavigationPages(PREVIEW_CATALOG, translate('pageDialogs'), translate).includes(entry),
        entry.id
      )
    }
  }
})
