// electron-builder 25 does not recognize `-` as an ad-hoc identity. This hook
// performs the complete nested signing pass before the DMG is assembled.
const fs = require('node:fs')
const path = require('node:path')
const { signAsync } = require('@electron/osx-sign')
const { walkAsync, getAppContentsPath } = require('@electron/osx-sign/dist/cjs/util')
const { isMachO, isSignable } = require('./macho.cjs')
const verify = require('./verify.cjs')
const { installApplication } = require('./engine.cjs')
const { nativeSignatureGuard } = require('./seal.cjs')
const shipit = require('../../native/shipit/artifact.cjs')

const CONTEXT_ENV = 'SCHOLARSEED_BUILD_CONTEXT'
const LOCAL_LANE = 'local'
const AD_HOC_IDENTITY = '-'
const ENTITLEMENTS = path.resolve(__dirname, '../../resources/entitlements.mac.plist')
const PACKAGE = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'))
const SIGN_IGNORE = PACKAGE.build.mac.signIgnore
const SIGN_LOG_MARKER = 'Signing... '
const SKIPPED_LOG_MARKER = 'Skipped... '
const VERIFIED_LOG_MARKER = 'Verified.'

function preserveReviewedRuntime(filename) {
  return SIGN_IGNORE.some(pattern => new RegExp(pattern).test(filename))
}

function shouldIgnore(filename) {
  return preserveReviewedRuntime(filename) || !isSignable(filename)
}

function frozenContext() {
  const filename = process.env[CONTEXT_ENV]
  if (!filename) throw new Error('use scripts/cd/build.cjs: a frozen build context is required')
  const context = JSON.parse(fs.readFileSync(filename, 'utf8'))
  if (context.schema !== 3 || context.file !== filename) throw new Error('invalid build context')
  return context
}

function applicationPath(builderContext, frozen) {
  const app = path.join(
    builderContext.appOutDir,
    `${builderContext.packager.appInfo.productFilename}.app`
  )
  if (!path.resolve(app).startsWith(`${frozen.output}${path.sep}`)) {
    throw new Error('builder app is outside this build output')
  }
  return app
}

function adHocOptions(app, ignore = shouldIgnore) {
  return {
    app,
    platform: 'darwin',
    identity: AD_HOC_IDENTITY,
    identityValidation: false,
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    // Codex and its official host are reviewed, pre-signed runtime inputs.
    // Re-signing them with Electron entitlements can make the custom Codex
    // fail macOS launch validation; the outer App seal still binds their bytes.
    // @electron/osx-sign 1.3 drops an ignore array while normalizing options;
    // a single predicate remains intact and is applied to every candidate.
    ignore,
    optionsForFile: () => ({
      entitlements: ENTITLEMENTS,
      hardenedRuntime: true,
      timestamp: 'none'
    })
  }
}

function decodeOutput(chunk) {
  if (typeof chunk === 'string') return chunk
  if (Buffer.isBuffer(chunk)) return chunk.toString('utf8')
  return String(chunk)
}

// @electron/osx-sign signs the same file list it walks and sorts. Counting that
// list up front keeps the denominator identical to the number of `Signing...`
// lines that stream out afterwards.
async function countSignableFiles(app, ignore) {
  const children = await walkAsync(getAppContentsPath({ app }))
  const signable = children.filter(filePath => !ignore(filePath)).length
  return signable + (ignore(app) ? 0 : 1)
}

// Prefix every `Signing... <path>` line with `[i/N]` while the pass runs. The
// wrapper is restored once the whole list is signed or the pass reports Verified.
async function trackSignProgress(app, ignore) {
  const total = await countSignableFiles(app, ignore)
  const originalWrite = process.stdout.write.bind(process.stdout)
  let signed = 0
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    process.stdout.write = originalWrite
  }
  process.stdout.write = (chunk, ...rest) => {
    const text = decodeOutput(chunk)
    // A `Signing...` line always wins so a buffered chunk that also carries a
    // `Skipped...` line can never drop a signature from the `[i/N]` count.
    const marker = text.indexOf(SIGN_LOG_MARKER)
    if (marker !== -1) {
      signed += 1
      originalWrite(`${text.slice(0, marker)}[${signed}/${total}] ${text.slice(marker)}`, ...rest)
      if (signed >= total) restore()
      return true
    }
    // Every skipped resource would otherwise print one line; with selective
    // signing that is thousands of lines of noise around the real progress.
    if (text.includes(SKIPPED_LOG_MARKER)) return true
    if (text.includes(VERIFIED_LOG_MARKER)) restore()
    return originalWrite(chunk, ...rest)
  }
  return restore
}

async function sign(builderContext) {
  const frozen = frozenContext()
  if (builderContext.electronPlatformName !== 'darwin') {
    installApplication(builderContext.appOutDir, frozen)
    await verify(builderContext)
    return
  }
  const app = applicationPath(builderContext, frozen)
  await shipit.install(app, frozen)
  // First prove every bundled runtime byte came from the frozen input. Signing
  // legitimately rewrites Mach-O metadata, so later gates compare the code seal.
  await verify(builderContext)
  if (verify.unsignedPackageCheck(frozen)) return
  const native = nativeSignatureGuard(app, frozen.native)
  const ignore = filename => native.ignore(filename) || shouldIgnore(filename)
  if (!frozen.signingRequired) {
    const restore = await trackSignProgress(app, ignore)
    try {
      await signAsync(adHocOptions(app, ignore))
      native.verify()
    } finally {
      restore()
    }
    const signed = await verify.verifyApplication(app, frozen, false)
    verify.atomicJSON(path.join(frozen.runDirectory, 'app.json'), signed)
    return
  }
  // Distribution signing runs through scripts/cd/signer.cjs via the builder's
  // `mac.sign` hook after this returns; install the counter against the same
  // Mach-O/bundle rule so its `Signing...` stream carries an accurate `[i/N]`.
  await trackSignProgress(app, ignore)
}

module.exports = sign
module.exports.adHocOptions = adHocOptions
module.exports.preserveReviewedRuntime = preserveReviewedRuntime
module.exports.isMachO = isMachO
module.exports.shouldIgnore = shouldIgnore
module.exports.countSignableFiles = countSignableFiles
module.exports.trackSignProgress = trackSignProgress

module.exports.frozenContext = frozenContext
