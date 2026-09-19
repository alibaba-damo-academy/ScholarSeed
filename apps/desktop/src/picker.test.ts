import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  IMPORT_PICKER_TARGET,
  isImportPickerTarget,
  supportsImportPickerTarget
} from './picker.ts'

const mainSource = readFileSync(new URL('./main/index.ts', import.meta.url), 'utf8')

test('import picker exposes unified and separate targets by platform', () => {
  assert.deepEqual(Object.values(IMPORT_PICKER_TARGET), ['resource', 'file', 'directory'])
  assert.equal(isImportPickerTarget(IMPORT_PICKER_TARGET.RESOURCE), true)
  assert.equal(isImportPickerTarget(IMPORT_PICKER_TARGET.FILE), true)
  assert.equal(isImportPickerTarget(IMPORT_PICKER_TARGET.DIRECTORY), true)
  assert.equal(isImportPickerTarget('unknown'), false)
  assert.equal(supportsImportPickerTarget('darwin', IMPORT_PICKER_TARGET.RESOURCE), true)
  assert.equal(supportsImportPickerTarget('win32', IMPORT_PICKER_TARGET.RESOURCE), false)
  assert.equal(supportsImportPickerTarget('linux', IMPORT_PICKER_TARGET.RESOURCE), false)
  assert.equal(supportsImportPickerTarget('win32', IMPORT_PICKER_TARGET.FILE), true)
  assert.equal(supportsImportPickerTarget('win32', IMPORT_PICKER_TARGET.DIRECTORY), true)
})

test('native dialogs combine targets only for the guarded macOS target', () => {
  assert.match(mainSource, /properties: \['openFile', 'openDirectory', 'multiSelections'\]/)
  assert.match(mainSource, /properties: \['openFile', 'multiSelections'\]/)
  assert.match(mainSource, /properties: \['openDirectory', 'multiSelections'\]/)
  assert.match(mainSource, /supportsImportPickerTarget\(process\.platform, target\)/)
})
