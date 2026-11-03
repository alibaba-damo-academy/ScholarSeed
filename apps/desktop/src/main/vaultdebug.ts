import { VAULT_ERROR, type VaultError } from '../vault.ts'

const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe'] as const
const NODE_DEBUG_OPTION = /^--(?:inspect(?:-brk|-wait|-port)?|debug(?:-brk|-port)?)(?:=|$)/
const CHROMIUM_DEBUG_OPTION = /^--remote-debugging-(?:port|pipe)(?:=|$)/
export interface VaultDebugContents { isDestroyed(): boolean; isDevToolsOpened(): boolean; debugger: { isAttached(): boolean } }
export interface VaultDebugEvidence {
  trustedStartup: boolean
  argv: readonly string[]
  execArgv: readonly string[]
  nodeOptions: string | undefined
  commandLine: { hasSwitch(name: string): boolean }
  inspectorUrl(): string | undefined
  contents(): readonly VaultDebugContents[]
}
function options(source: string): string[] | null {
  const tokens: string[] = []
  let token = ''
  let quote: string | null = null
  let escaped = false
  for (const character of source) {
    if (escaped) { token += character; escaped = false }
    else if (character === '\\') escaped = true
    else if (quote) { if (character === quote) quote = null; else token += character }
    else if (character === '"' || character === "'") quote = character
    else if (/\s/.test(character)) { if (token) tokens.push(token); token = '' }
    else token += character
  }
  if (quote || escaped) return null
  if (token) tokens.push(token)
  return tokens
}
export function createVaultDebugPolicy(evidence: VaultDebugEvidence): () => VaultError | null {
  let startup: VaultError | null = null
  try {
    const node = options(evidence.nodeOptions ?? '')
    if (!evidence.trustedStartup || !node) startup = VAULT_ERROR.debugUnknown
    else if ([...evidence.argv, ...evidence.execArgv, ...node].some(option => NODE_DEBUG_OPTION.test(option) || CHROMIUM_DEBUG_OPTION.test(option))
      || DEBUG_SWITCHES.some(name => evidence.commandLine.hasSwitch(name))) startup = VAULT_ERROR.debugUnsafe
  } catch { startup = VAULT_ERROR.debugUnknown }
  return () => {
    if (startup) return startup
    try {
      if (DEBUG_SWITCHES.some(name => evidence.commandLine.hasSwitch(name)) || evidence.inspectorUrl() !== undefined) return VAULT_ERROR.debugUnsafe
      if (evidence.contents().some(contents => !contents.isDestroyed() && (contents.isDevToolsOpened() || contents.debugger.isAttached()))) return VAULT_ERROR.debugUnsafe
      return null
    } catch { return VAULT_ERROR.debugUnknown }
  }
}
