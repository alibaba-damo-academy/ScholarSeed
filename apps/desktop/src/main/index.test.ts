import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

test('Office renderer diagnostics persist through the existing rotating window log', () => {
  assert.match(
    source,
    /details\.message\.startsWith\('\[office-runtime\]'\)[\s\S]*?logWindowLifecycle\(/
  )
})

test('pushLog does not send IPC through disposed renderer webContents', () => {
  assert.match(
    source,
    /function aliveMainWindow\(\): BrowserWindow \| null \{\s*if \(!mainWindow \|\| mainWindow\.isDestroyed\(\) \|\| mainWindow\.webContents\.isDestroyed\(\)\) return null/
  )
  assert.match(
    source,
    /function sendToMainWindow\(channel: string, \.\.\.args: unknown\[\]\): boolean \{\s*const win = aliveMainWindow\(\)/
  )
})

test('main-process callbacks validate sender through alive main window', () => {
  assert.match(
    source,
    /function isMainWindowSender\(\s*sender: Electron\.WebContents,\s*senderFrame\?: Electron\.WebFrameMain \| null\s*\): boolean \{\s*const win = aliveMainWindow\(\)/
  )
  assert.match(
    source,
    /notification\.on\('click', \(\) => \{\s*const win = aliveMainWindow\(\)\s*if \(!win\) return/
  )
  assert.match(
    source,
    /ipcMain\.handle\('scholarseed:pick-dir', async \(\) => \{\s*const win = aliveMainWindow\(\)/
  )
})

test('main window installs the CSP owned by the lifecycle-safe policy module', () => {
  assert.match(
    source,
    /import \{ installContentSecurityPolicy, mainWindowContentSecurityPolicy \} from '\.\/csp'/
  )
  assert.match(
    source,
    /installContentSecurityPolicy\(\s*mainWindow,\s*mainWindowContentSecurityPolicy\(await accountBaseUrlFromServe\(\)\)/
  )
})
