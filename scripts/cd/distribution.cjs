const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '../..')
const TOOLCHAIN = path.join(ROOT, 'scripts/pre/toolchain.cjs')
const PYTHON = path.join(ROOT, 'scripts/shared/python.cjs')
const DESKTOP = path.join(ROOT, 'scripts/shared/desktop.cjs')
const SMOKE = path.join(__dirname, '../ci/smoke.cjs')

function main(argv = process.argv.slice(2), { launch = spawnSync } = {}) {
  const commands = [[TOOLCHAIN, 'ensure'], [PYTHON, 'prepare-dev'],
    [SMOKE], [DESKTOP, 'package:distribution', ...argv]]
  for (const args of commands) {
    const result = launch(process.execPath, args, {
      cwd: ROOT, stdio: 'inherit', env: process.env, shell: false, windowsHide: true
    })
    if (result.error) throw result.error
    if (result.status !== 0) return result.status ?? 1
  }
  return 0
}

module.exports = { main }

if (require.main === module) {
  try { process.exitCode = main() } catch (error) {
    console.error(`[package:dist] ${error.stack || error.message}`)
    process.exitCode = 1
  }
}
