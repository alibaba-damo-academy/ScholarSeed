// Invoked only by vpk. Preserve vendor binaries and already-frozen native modules.
const path = require('node:path')
const { signFile, verify } = require('./windows-sign.cjs')
const CI_NAMES = ['CI', 'GITLAB_CI', 'GITHUB_ACTIONS', 'AONE_CI']
async function main() {
  if (!CI_NAMES.some(name => /^(1|true)$/i.test(process.env[name] || ''))) throw new Error('Velopack signing is CI-only')
  if (process.argv.length !== 3) throw new Error('expected one signing input')
  const filename = process.argv[2]
  const normalized = filename.replaceAll('\\', '/')
  const name = path.basename(filename)
  if (normalized.includes('/resources/') || !/^(Uninstall\.exe|Update\.exe|Squirrel\.exe|ScholarSeed\.exe|.*_ExecutionStub\.exe|.*Setup\.exe)$/i.test(name)) return
  try { verify(filename, process.env.SCHOLARSEED_WINDOWS_SIGN_PUBLISHER); return } catch { /* Generated stub/setup requires signing. */ }
  await signFile(filename)
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { main }
