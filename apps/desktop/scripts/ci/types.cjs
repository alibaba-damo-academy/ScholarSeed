const { spawnSync } = require('node:child_process')
const { resolve } = require('node:path')
const ts = require('typescript')
const { childExitCode } = require('../../../../scripts/shared/execution.cjs')

const DESKTOP = resolve(__dirname, '../..')
const SOLUTION = 'tsconfig.json'
const COMPILER = require.resolve('typescript/bin/tsc')

function projects(desktop = DESKTOP) {
  const filename = resolve(desktop, SOLUTION)
  const { config: solution, error } = ts.readConfigFile(filename, ts.sys.readFile)
  if (error)
    throw new Error(
      `${filename}: TS${error.code}: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`
    )
  if (!Array.isArray(solution.references) || !solution.references.length) {
    throw new Error(`${SOLUTION} must reference the Desktop type-check projects`)
  }
  return solution.references.map((reference) => {
    if (typeof reference.path !== 'string' || !reference.path)
      throw new Error('Invalid TypeScript project reference')
    return resolve(desktop, reference.path)
  })
}

function run({ desktop = DESKTOP, execute = spawnSync, args = [] } = {}) {
  const configured = projects(desktop)
  for (const [index, project] of configured.entries()) {
    const forwarded = index === configured.length - 1 ? args : []
    const result = execute(process.execPath, [COMPILER, '--noEmit', '-p', project, ...forwarded], {
      cwd: desktop,
      stdio: 'inherit',
      windowsHide: true,
    })
    if (result.error) throw result.error
    const exitCode = childExitCode(result)
    if (exitCode !== 0) return exitCode
  }
  return 0
}

module.exports = { projects, run }

if (require.main === module) {
  try {
    process.exitCode = run({ args: process.argv.slice(2) })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
