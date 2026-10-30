const path = require('node:path')
const childProcess = require('node:child_process')
const { timed } = require('../../../../scripts/shared/timing.cjs')

const QUERY_TIMEOUT_MS = 30000
const HIVES = new Set(['CurrentUser', 'LocalMachine'])
const VIEWS = new Set(['Registry64', 'Registry32'])
const KINDS = new Set(['velopack', 'nsis-install', 'nsis-uninstall'])

// Changing HOME or --installto does not isolate HKCU/HKLM. Only complete orphaned
// CI NSIS registrations under the explicitly configured root may be reclaimed.
function assertCleanInstallation(appId, environment = process.env) {
  return timed('verification.installation-preflight', () => {
    if (typeof appId !== 'string' || !/^[a-zA-Z0-9_.-]+$/.test(appId))
      throw new Error('invalid installation preflight app ID')
    const ps = path.join(environment.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const output = childProcess.execFileSync(ps, ['-NoProfile', '-NonInteractive', '-File',
      path.join(__dirname, 'registration.ps1'), '-AppId', appId],
    { env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, timeout: QUERY_TIMEOUT_MS })
    const records = JSON.parse(output.replace(/^\uFEFF/, ''))
    if (!Array.isArray(records) || records.some(record => !record || !HIVES.has(record.hive) ||
        !VIEWS.has(record.view) || !KINDS.has(record.kind)))
      throw new Error('invalid installation registration query result')
    if (records.length) {
      console.log(`[installer-preflight] ${JSON.stringify({ status: 'blocked', registrations: records })}`)
      throw new Error('existing NSIS/Velopack registration prevents isolated acceptance; inspect the listed registry scope and explicitly remediate stale CI state; do not run Setup or bypass migration elevation checks')
    }
    console.log('[installer-preflight] {"status":"passed","registrations":[]}')
  })
}

module.exports = { assertCleanInstallation }
