const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { childExitCode } = require('../../../../scripts/shared/execution.cjs')

const DESKTOP = path.resolve(__dirname, '../..')
const TOOLCHAIN = path.resolve(DESKTOP, '../../scripts/pre/toolchain.cjs')
const CONTRACT_FILES = Object.freeze([
  '../../scripts/shared/__tests__/artifacts.test.cjs',
  'runtime/codex.test.cjs',
  'runtime/browser.test.cjs',
  'runtime/python.test.cjs',
  'runtime/powershell.test.cjs',
  'runtime/texlive.test.cjs',
  'runtime/components.test.cjs',
  'scripts/cd/__tests__/browser.test.cjs',
  'scripts/cd/__tests__/execution.test.cjs',
  'scripts/cd/__tests__/closure.test.cjs',
  'scripts/shared/__tests__/python.test.cjs',
  'scripts/cd/__tests__/toolchain.test.cjs',
])

function invocations(forwarded = []) {
  return [
    [TOOLCHAIN, 'check'],
    ['--test', ...CONTRACT_FILES],
    [TOOLCHAIN, 'run', 'i18n:test', ...forwarded],
  ].map((args) => ({ executable: process.execPath, args }))
}

function main({ launch = spawnSync, argv = process.argv.slice(2) } = {}) {
  for (const command of invocations(argv)) {
    const result = launch(command.executable, command.args, {
      cwd: DESKTOP,
      stdio: 'inherit',
      env: process.env,
      windowsHide: true,
    })
    if (result.error) throw result.error
    if (result.status !== 0) return childExitCode(result)
  }
  return 0
}

module.exports = { TOOLCHAIN, CONTRACT_FILES, invocations, main }
if (require.main === module) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(`[desktop:pretest] ${error.message}`)
    process.exitCode = 1
  }
}
