const { main: runOps } = require('./ops-cli.cjs')
const { resolveCommand } = require('./shared/commands.cjs')
const { CommandError } = require('./shared/execution.cjs')

const DISTRIBUTION_COMMANDS = {
  'package:dist': ['cd', 'build', 'release', '--workflow', 'distribution'],
  'package:check': ['cd', 'build', 'release', '--stage', 'dir', '--candidate']
}

function translate(argv) {
  const [command, ...args] = argv
  if (command === 'package:verify') {
    throw new CommandError('UNSUPPORTED', '冻结产物验收续跑尚无可用 Owner 实现；不会重建、跳过或复用旧结果')
  }
  if (!Object.hasOwn(DISTRIBUTION_COMMANDS, command)) {
    throw new CommandError('INVALID_ARGUMENT', 'Only package:dist, package:check and package:verify are distribution contracts', 2)
  }
  const forwarded = []
  for (const argument of args) {
    if (argument === '--skip-check' || argument.startsWith('--skip-check=')) {
      throw new CommandError('UNSUPPORTED', '--skip-check 尚无可用 Owner 实现；不会忽略请求或绕过启动验收')
    }
    forwarded.push(argument === '--type' ? '--channel' : argument)
  }
  const canonical = [...DISTRIBUTION_COMMANDS[command], ...forwarded]
  resolveCommand(canonical)
  return canonical
}

async function main(argv = process.argv.slice(2), run = runOps) {
  return run(translate(argv))
}

module.exports = { translate, main }
if (require.main === module) {
  main().then(code => { process.exitCode = code }).catch(error => {
    console.error(`[distribution] ${error.code || 'EXECUTION_FAILED'}: ${error.message}`)
    process.exitCode = error.exitCode ?? 1
  })
}
