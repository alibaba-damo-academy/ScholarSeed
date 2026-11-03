const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

async function sha256(filename) {
  const hash = crypto.createHash('sha256')
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

async function collect(resultFile, destination, { repo, commit, channel }) {
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
  assert.ok(commit && ['preview', 'release'].includes(channel), 'Expected source and channel are required')
  assert.equal(result.status, 'passed', 'Build did not pass')
  assert.equal(result.publishable, true, 'Build is not publishable')
  assert.equal(result.verification_skipped, false, 'Verification was skipped')
  assert.equal(result.source?.commit, commit, 'Build belongs to a different commit')
  assert.equal(result.release?.channel, channel, 'Build belongs to a different channel')
  assert.equal(result.release?.platform, 'darwin')
  assert.equal(result.release?.arch, 'arm64')
  assert.equal(result.trust?.level, 'developer-id-notarized', 'Notarization evidence is missing')
  assert.equal(result.artifacts?.app?.signature_valid, true, 'Application signature is missing')
  const dmg = result.artifacts?.dmg
  assert.equal(dmg?.signature_valid, true, 'DMG signature is missing')
  assert.equal(dmg.installed_check?.status, 'passed', 'Mounted DMG acceptance did not pass')
  assert.equal(dmg.installed_check?.source, 'mounted-dmg')
  assert.equal(dmg.installed_check?.detached, true)
  assert.equal(dmg.installed_check?.package_check?.ok, true)
  assert.equal(dmg.installed_check?.sha256, dmg.sha256)
  const root = fs.realpathSync(path.join(repo, 'apps/desktop/release'))
  const filename = fs.realpathSync(dmg.path)
  const relative = path.relative(root, filename)
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'DMG is outside the release directory')
  assert.equal(path.extname(filename), '.dmg')
  assert.equal(fs.statSync(filename).size, dmg.size, 'DMG size changed')
  assert.equal(await sha256(filename), dmg.sha256, 'DMG digest changed')
  fs.mkdirSync(destination, { recursive: true })
  const target = path.join(destination, path.basename(filename))
  fs.copyFileSync(filename, target, fs.constants.COPYFILE_EXCL)
  assert.equal(await sha256(target), dmg.sha256, 'Copied DMG digest changed')
  fs.writeFileSync(path.join(destination, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx' })
  fs.writeFileSync(path.join(destination, 'SHA256SUMS'), `${dmg.sha256}  ${path.basename(filename)}\n`, { flag: 'wx' })
}

module.exports = { collect }
if (require.main === module) {
  const [resultFile, destination] = process.argv.slice(2)
  collect(resultFile, destination, {
    repo: process.env.GITHUB_WORKSPACE,
    commit: process.env.GITHUB_SHA,
    channel: process.env.PACKAGE_CHANNEL,
  }).catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
