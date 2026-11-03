export type CommandOutcome =
  | 'none'
  | 'noMatches'
  | 'commandNotFound'
  | 'permissionDenied'
  | 'fileMissing'
  | 'nonzero'
  | 'unknown'

type CommandTool = {
  name: string
  status: 'running' | 'done' | 'error' | 'cancelled'
  input?: unknown
  result?: string
  exitCode?: number | null
}

const SEARCH_COMMAND = /^\s*(?:rg|grep)\s+[^;&|<>\n$()]+\s*$/
const SHELL_WRAPPER = /^(?:\/bin\/)?(?:zsh|bash)\s+-lc\s+'([^']*)'$/
const SHELL_COMMAND_NOT_FOUND = /(?:^|\n)(?:zsh:\d+:|bash: line \d+:)[^\n]*\b(?:command )?not found\b/i
const SHELL_PERMISSION_DENIED = /(?:^|\n)(?:zsh:\d+:|bash: line \d+:)[^\n]*\bpermission denied\b/i
const MISSING_FILE = /(?:^|\n)(?:rg|grep):[^\n]*\b(?:no such file or directory|not a directory)\b/i

export function commandOutcome(item: CommandTool): CommandOutcome {
  if (item.status !== 'error') return 'none'
  const input = item.input && typeof item.input === 'object' ? item.input as {
    command?: unknown
    actions?: unknown
  } : undefined
  const searchAction = item.name === 'read' && Array.isArray(input?.actions) && input.actions.length === 1
    ? input.actions[0] as { type?: unknown; command?: unknown }
    : undefined
  const wrappedCommand = typeof input?.command === 'string'
    ? SHELL_WRAPPER.exec(input.command)?.[1]
    : undefined
  const command = item.name === 'bash'
    ? input?.command
    : searchAction?.type === 'search' && typeof wrappedCommand === 'string' && SEARCH_COMMAND.test(wrappedCommand)
      ? searchAction.command : undefined
  const output = item.result ?? ''
  if (
    item.exitCode === 1 &&
    typeof command === 'string' &&
    SEARCH_COMMAND.test(command) &&
    output.trim() === ''
  ) {
    return 'noMatches'
  }
  if (item.name !== 'bash' && item.name !== 'read') return 'none'
  if (SHELL_COMMAND_NOT_FOUND.test(output)) return 'commandNotFound'
  if (SHELL_PERMISSION_DENIED.test(output)) return 'permissionDenied'
  if (MISSING_FILE.test(output)) return 'fileMissing'
  return typeof item.exitCode === 'number' ? 'nonzero' : 'unknown'
}
