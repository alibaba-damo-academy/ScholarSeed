const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { createHash } = require('node:crypto')
const electronExecutable = require('electron')
const { build: desktopBuild } = require('../../package.json')

const MACOS_PLATFORM = 'darwin'
const GIT_COMMAND = 'git'
const PLUTIL_COMMAND = '/usr/bin/plutil'
const PRODUCT_NAME = desktopBuild.productName
const DISPLAY_NAME_SEPARATOR = ' · '
const DETACHED_SHA_LENGTH = 12
const INFO_PLIST_FILENAME = 'Info.plist'
const BUNDLE_NAME_KEYS = ['CFBundleName', 'CFBundleDisplayName']
const DEVELOPMENT_BUNDLE_PREFIX = 'com.scholarseed.desktop.dev'
const BUNDLE_ID_HASH_LENGTH = 16
const URL_SCHEME = 'scholarseed'
const LSREGISTER_COMMAND = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

function registerMacDevelopmentBundle(infoPlist, platform = process.platform, runner = execFileSync) {
  if (platform !== MACOS_PLATFORM) return false
  // LaunchServices identifies applications by bundle ID, not their display name.
  // A checkout-local ID prevents another stock Electron.app from receiving our URL.
  const bundlePath = path.dirname(path.dirname(infoPlist))
  const suffix = createHash('sha256').update(bundlePath).digest('hex').slice(0, BUNDLE_ID_HASH_LENGTH)
  runner(PLUTIL_COMMAND, ['-replace', 'CFBundleIdentifier', '-string', `${DEVELOPMENT_BUNDLE_PREFIX}.${suffix}`, infoPlist])
  const protocols = [{ CFBundleURLName: PRODUCT_NAME, CFBundleURLSchemes: [URL_SCHEME], CFBundleTypeRole: 'Editor' }]
  runner(PLUTIL_COMMAND, ['-replace', 'CFBundleURLTypes', '-json', JSON.stringify(protocols), infoPlist])
  runner(LSREGISTER_COMMAND, ['-f', bundlePath])
  return true
}

function runGit(repoRoot, args, runner) {
  return runner(GIT_COMMAND, args, { cwd: repoRoot, encoding: 'utf8' }).trim()
}

function resolveGitIdentity(repoRoot, runner = execFileSync) {
  const branch = runGit(repoRoot, ['branch', '--show-current'], runner)
  if (branch) return branch

  const revision = runGit(repoRoot, ['rev-parse', `--short=${DETACHED_SHA_LENGTH}`, 'HEAD'], runner)
  if (!revision) throw new Error('cannot resolve Git branch or revision for desktop development identity')
  return revision
}

function developmentDisplayName(identity) {
  if (!identity) throw new Error('desktop development identity must not be empty')
  return `${PRODUCT_NAME}${DISPLAY_NAME_SEPARATOR}${identity}`
}

function updateMacBundleName(infoPlist, displayName, platform = process.platform, runner = execFileSync) {
  if (platform !== MACOS_PLATFORM) return false
  for (const key of BUNDLE_NAME_KEYS) {
    runner(PLUTIL_COMMAND, ['-replace', key, '-string', displayName, infoPlist])
  }
  return true
}

function electronInfoPlist(executable = electronExecutable) {
  const contents = path.dirname(path.dirname(executable))
  return path.join(contents, INFO_PLIST_FILENAME)
}

function main() {
  if (process.platform !== MACOS_PLATFORM) return
  const defaultRepoRoot = path.join(__dirname, '../../../..')
  const repoRoot = path.resolve(process.argv[2] || defaultRepoRoot)
  const identity = resolveGitIdentity(repoRoot)
  const displayName = developmentDisplayName(identity)
  updateMacBundleName(electronInfoPlist(), displayName)
  registerMacDevelopmentBundle(electronInfoPlist())
  process.stdout.write(`[desktop-dev] macOS app name: ${displayName}\n`)
}

if (require.main === module) main()

module.exports = {
  developmentDisplayName,
  electronInfoPlist,
  resolveGitIdentity,
  registerMacDevelopmentBundle,
  updateMacBundleName
}
