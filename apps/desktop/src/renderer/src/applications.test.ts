import assert from 'node:assert/strict'
import test from 'node:test'

import { uniqueApplications } from './applications.ts'

test('application candidates preserve different paths with the same display name', () => {
  assert.deepEqual(
    uniqueApplications([
      { name: 'WPS Office', path: '/Applications/wpsoffice.app', isDefault: true },
      { name: 'LibreOffice', path: '/Applications/LibreOffice.app', isDefault: false },
      { name: ' libreoffice ', path: '/Volumes/LibreOffice.app', isDefault: false },
      { name: 'Microsoft Word', path: '/Applications/Microsoft Word.app', isDefault: false },
    ]),
    [
      { name: 'WPS Office', path: '/Applications/wpsoffice.app', isDefault: true },
      { name: 'LibreOffice', path: '/Applications/LibreOffice.app', isDefault: false },
      { name: ' libreoffice ', path: '/Volumes/LibreOffice.app', isDefault: false },
      { name: 'Microsoft Word', path: '/Applications/Microsoft Word.app', isDefault: false },
    ]
  )
})

test('application identity retains the system default and does not collapse missing paths', () => {
  const first = { name: 'Viewer', path: '/Applications/Viewer.app', isDefault: false }
  const preferred = { ...first, isDefault: true }
  const missing = { name: 'Viewer', path: '', isDefault: false }
  assert.deepEqual(uniqueApplications([first, preferred, missing, missing]), [
    preferred,
    missing,
    missing,
  ])
})
