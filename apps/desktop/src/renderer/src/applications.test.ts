import assert from 'node:assert/strict'
import test from 'node:test'

import { uniqueApplications } from './applications.ts'

test('application candidates keep the first system-ranked entry per display name', () => {
  assert.deepEqual(uniqueApplications([
    { name: 'WPS Office', path: '/Applications/wpsoffice.app', isDefault: true },
    { name: 'LibreOffice', path: '/Applications/LibreOffice.app', isDefault: false },
    { name: ' libreoffice ', path: '/Volumes/LibreOffice.app', isDefault: false },
    { name: 'Microsoft Word', path: '/Applications/Microsoft Word.app', isDefault: false }
  ]), [
    { name: 'WPS Office', path: '/Applications/wpsoffice.app', isDefault: true },
    { name: 'LibreOffice', path: '/Applications/LibreOffice.app', isDefault: false },
    { name: 'Microsoft Word', path: '/Applications/Microsoft Word.app', isDefault: false }
  ])
})
