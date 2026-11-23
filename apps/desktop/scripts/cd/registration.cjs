const path = require('node:path')
const fs = require('node:fs')
const childProcess = require('node:child_process')
const { timed } = require('../../../../scripts/shared/timing.cjs')
const { assertWindowsPermissions, protectWindowsDirectory } = require('../../../../scripts/shared/permissions.cjs')
const { withVerificationMutex } = require('./acceptance.cjs')
const { product_id: productId } = require('../../resources/product.json')

const QUERY_TIMEOUT_MS = 30000
const HIVES = new Set(['CurrentUser', 'LocalMachine'])
const VIEWS = new Set(['Registry64', 'Registry32'])
const KINDS = new Set(['velopack', 'nsis-install', 'nsis-uninstall'])
const CI_VELOPACK_ROOT = 'SCHOLARSEED_CI_VELOPACK_ROOT'
const CI_LEGACY_ROOT = 'SCHOLARSEED_CI_REGISTRATION_ROOT'
const RECEIPT_DIRECTORY = '.installer-registration'
const APP_ID = /^[a-zA-Z0-9_.-]+$/
const VERSION = /^\d+\.\d+\.\d+$/
const SANDBOX = /^v-[a-zA-Z0-9]+$/

function receiptFile(appId, environment) {
  const configured = environment[CI_VELOPACK_ROOT]
  if (!configured) return null
  if (!/^[a-z]:[\\/]/i.test(configured)) throw new Error('CI Velopack verification root must be a local absolute directory')
  const root = path.resolve(configured)
  if (root === path.parse(root).root) throw new Error('CI Velopack verification root must not be a drive root')
  return path.join(root, RECEIPT_DIRECTORY, `${appId}.json`)
}

function readReceipt(appId, environment) {
  const file = receiptFile(appId, environment)
  if (!file) return null
  let status
  try { status = fs.lstatSync(file) }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  if (!status.isFile()) throw new Error('invalid CI Velopack receipt file')
  assertWindowsPermissions(path.dirname(file))
  assertWindowsPermissions(file)
  const { sandbox, version } = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (typeof sandbox !== 'string' || !SANDBOX.test(sandbox) || typeof version !== 'string' || !VERSION.test(version))
    throw new Error('invalid CI Velopack receipt')
  return { install: path.join(path.dirname(path.dirname(file)), sandbox, 'app'), version }
}

function recordCiInstallation(frozen, directory) {
  const file = receiptFile(frozen.appId, process.env)
  if (!file) return
  const receiptDirectory = path.dirname(file)
  const root = path.dirname(receiptDirectory)
  const sandbox = path.basename(directory)
  if (path.dirname(directory).toLowerCase() !== root.toLowerCase() || !SANDBOX.test(sandbox) || !VERSION.test(frozen.version))
    throw new Error('CI Velopack receipt does not match the verification sandbox')
  try {
    fs.mkdirSync(receiptDirectory)
    protectWindowsDirectory(receiptDirectory)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    assertWindowsPermissions(receiptDirectory)
  }
  // Replace the previous attempt only after the locked preflight has cleared it.
  const temporary = `${file}.pending-${process.pid}`
  fs.writeFileSync(temporary, JSON.stringify({ sandbox, version: frozen.version }), { flag: 'wx' })
  try { fs.renameSync(temporary, file) }
  finally { fs.rmSync(temporary, { force: true }) }
}

function completeCiInstallation(appId) {
  const file = receiptFile(appId, process.env)
  if (!file) return
  // A successful uninstall must remove its registration without remediation.
  assertCleanInstallation(appId, { ...process.env, [CI_VELOPACK_ROOT]: '', [CI_LEGACY_ROOT]: '' })
  fs.unlinkSync(file)
}

// Changing HOME or --installto does not isolate HKCU/HKLM.
function assertCleanInstallation(appId, environment = process.env, recoverCiVelopack = false) {
  return timed('verification.installation-preflight', () => {
    if (typeof appId !== 'string' || !APP_ID.test(appId))
      throw new Error('invalid installation preflight app ID')
    const ps = path.join(environment.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const receipt = recoverCiVelopack ? readReceipt(appId, environment) : null
    const output = childProcess.execFileSync(ps, ['-NoProfile', '-NonInteractive', '-File',
      path.join(__dirname, 'registration.ps1'), '-AppId', appId,
      ...(receipt ? ['-CiInstall', receipt.install, '-CiVersion', receipt.version] : [])],
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

module.exports = { assertCleanInstallation, completeCiInstallation, recordCiInstallation }

if (require.main === module) {
  if (process.platform !== 'win32' || process.argv.length !== 2) {
    console.error('Installer registration preflight requires Windows and accepts no arguments')
    process.exitCode = 1
  } else {
    withVerificationMutex(() => assertCleanInstallation(productId, process.env, true)).catch(error => {
      console.error(`[installer-preflight] ERROR ${error.message}`)
      process.exitCode = 1
    })
  }
}
