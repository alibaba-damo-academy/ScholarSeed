const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { childExitCode } = require('../../../../scripts/shared/execution.cjs')

const DESKTOP = path.resolve(__dirname, '../..')
const TOOLCHAIN = path.resolve(DESKTOP, '../../scripts/pre/toolchain.cjs')
const PLAYWRIGHT = path.join(DESKTOP, 'node_modules/@playwright/test/cli.js')
const PROJECTS = Object.freeze({ mr: 'smoke', live: 'live', update: 'update' })

function main(argv = process.argv.slice(2), { launch = spawnSync } = {}) {
  const [suite, ...forwarded] = argv
  if (!Object.hasOwn(PROJECTS, suite)) throw new Error(`Unknown E2E suite: ${suite}`)
  const commands = [
    [TOOLCHAIN, 'run', 'build'],
    [PLAYWRIGHT, 'test', `--project=${PROJECTS[suite]}`, ...forwarded],
  ]
  for (const args of commands) {
    const result = launch(process.execPath, args, {
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

module.exports = { main }
if (require.main === module) {
  try {
    process.exitCode = main()
  } catch (error) {
    console.error(`[desktop:e2e] ${error.message}`)
    process.exitCode = 1
  }
}
