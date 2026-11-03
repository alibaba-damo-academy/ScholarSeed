import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

test('menu diagnostics use the existing rotating window log', () => {
  assert.match(source, /createMenuOwner\(browserWindow, \{\s*log: logWindowLifecycle,/)
})

test('Windows native notification diagnostics use the existing rotating window log', () => {
  assert.match(source, /new WindowsNotifications\(toastNative, logWindowLifecycle\)/)
})

test('registered renderer diagnostics persist through the existing rotating window log', () => {
  assert.match(source, /isRendererDiagnostic\(details\.message\)[\s\S]*?logWindowLifecycle\(/)
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
    /function deliverAttentionActivation\(\): void \{[\s\S]*?const window = aliveMainWindow\(\)[\s\S]*?if \(!attentionRendererReady \|\| !window \|\| !pendingAttentionId\) return/
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
    /installContentSecurityPolicy\(\s*mainWindow,\s*mainWindowContentSecurityPolicy\(launchAccountBase\)/
  )
})
