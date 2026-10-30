// electron-builder afterSign hook: submit the exact signed App to Apple's
// notary service, staple it, and persist the receipt in this build's context.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const verify = require('./verify.cjs')

const APP_EXTENSION = '.app'
const APPLE_API_ISSUER_ENV = 'SCHOLARSEED_APPLE_API_ISSUER'
const APPLE_API_KEY_ENV = 'SCHOLARSEED_APPLE_API_KEY'
const APPLE_API_KEY_ID_ENV = 'SCHOLARSEED_APPLE_API_KEY_ID'
const BUILD_CONTEXT_ENV = 'SCHOLARSEED_BUILD_CONTEXT'
const NOTARY_PROFILE_ENV = 'SCHOLARSEED_NOTARY_KEYCHAIN_PROFILE'
const NOTARY_ACCEPTED_STATUS = 'Accepted'
// notarytool settles on Accepted/Invalid/Rejected; everything else is pending.
const NOTARY_PENDING_STATUSES = new Set(['In Progress'])
const NOTARY_POLL_INTERVAL_MS = 15000
// Polling replaced a single `--wait`; cap it so a stuck queue fails the build
// instead of hanging it forever (240 * 15s = 1 hour).
const NOTARY_MAX_POLLS = 240
// Replacing `--wait` also dropped its internal retries, so a transient network
// or token error on one `info` call must not fail an already uploaded build.
const NOTARY_REQUEST_ATTEMPTS = 3
const LOG_PREFIX = '[notarize]'

function log(message) {
  process.stdout.write(`${LOG_PREFIX} ${message}\n`)
}

function elapsedSeconds(startedAt) {
  return Math.round((Date.now() - startedAt) / 1000)
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function command(executable, args) {
  return execFileSync(executable, args, { encoding: 'utf8' }).trim()
}

function notaryRequest(args) {
  return JSON.parse(command('xcrun', ['notarytool', ...args, '--output-format', 'json']))
}

function credentials(environment) {
  const profile = environment[NOTARY_PROFILE_ENV]
  if (profile) return ['--keychain-profile', profile]
  const issuer = environment[APPLE_API_ISSUER_ENV]
  const key = environment[APPLE_API_KEY_ENV]
  const keyId = environment[APPLE_API_KEY_ID_ENV]
  if (issuer && key && keyId) return ['--key', key, '--key-id', keyId, '--issuer', issuer]
  throw new Error(
    `${NOTARY_PROFILE_ENV} or ${APPLE_API_KEY_ENV}, ${APPLE_API_KEY_ID_ENV}, and ${APPLE_API_ISSUER_ENV} are required`
  )
}

function buildContext() {
  const filename = process.env[BUILD_CONTEXT_ENV]
  if (!filename) throw new Error(`${BUILD_CONTEXT_ENV} is required`)
  const context = JSON.parse(fs.readFileSync(filename, 'utf8'))
  if (context.schema !== 3 || context.file !== filename) throw new Error('invalid build context')
  return context
}

function requestWithRetry(request, attempts) {
  return (submissionId, credentialArgs) => {
    let lastError
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return request(submissionId, credentialArgs)
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }
}

// notarytool reports the queued submission before Apple finishes processing it;
// poll until the status settles so the log shows real progress instead of one
// silent `--wait` call.
function waitForNotarization(submissionId, credentialArgs, options = {}) {
  const request = requestWithRetry(options.request || notaryInfo,
    options.attempts || NOTARY_REQUEST_ATTEMPTS)
  const wait = options.wait || sleep
  const maxPolls = options.maxPolls || NOTARY_MAX_POLLS
  const startedAt = Date.now()
  for (let poll = 0; poll < maxPolls; poll += 1) {
    const receipt = request(submissionId, credentialArgs)
    log(`submission ${submissionId} status=${receipt.status} waiting=${elapsedSeconds(startedAt)}s`)
    if (!NOTARY_PENDING_STATUSES.has(receipt.status)) return receipt
    wait(NOTARY_POLL_INTERVAL_MS)
  }
  throw new Error(`Apple notarization did not settle within ${maxPolls} polls: ${submissionId}`)
}

function notaryInfo(submissionId, credentialArgs) {
  return notaryRequest(['info', submissionId, ...credentialArgs])
}

exports.default = async function notarizeMacApplication(context) {
  if (context.electronPlatformName !== 'darwin') return
  const frozen = buildContext()
  if (!frozen.signingRequired) return

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}${APP_EXTENSION}`
  )
  const archive = path.join(frozen.runDirectory, 'notarization.zip')
  const credentialArgs = credentials(process.env)
  try {
    const compressStartedAt = Date.now()
    log(`compressing ${appPath}`)
    command('/usr/bin/ditto', ['-c', '-k', '--keepParent', appPath, archive])
    log(`archive ${fs.statSync(archive).size} bytes in ${elapsedSeconds(compressStartedAt)}s`)

    log('submitting to Apple (upload and queueing can take several minutes)')
    const submission = notaryRequest(['submit', archive, ...credentialArgs])
    if (!submission.id) {
      throw new Error(`Apple notarization submission missing id: ${submission.status || 'unknown'}`)
    }
    log(`submitted ${submission.id} status=${submission.status}`)

    const receipt = waitForNotarization(submission.id, credentialArgs)
    if (receipt.status !== NOTARY_ACCEPTED_STATUS || !receipt.id) {
      throw new Error(`Apple notarization was not accepted: ${receipt.status || 'unknown'}`)
    }

    log(`accepted ${receipt.id}, stapling ${appPath}`)
    command('xcrun', ['stapler', 'staple', appPath])
    verify.atomicJSON(path.join(frozen.runDirectory, 'notary.json'), {
      id: receipt.id,
      status: receipt.status,
      message: typeof receipt.message === 'string' ? receipt.message : ''
    })
    log(`notarization complete: ${receipt.id}`)
  } finally {
    fs.rmSync(archive, { force: true })
  }
}

module.exports.credentials = credentials
module.exports.waitForNotarization = waitForNotarization
