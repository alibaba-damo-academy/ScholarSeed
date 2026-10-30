const PORT_SWITCH = '--remote-debugging-port'
const ADDRESS_SWITCH = '--remote-debugging-address'
const LOOPBACK = '127.0.0.1'
const MAX_PORT = 65535

function argumentValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.findIndex((argument) => argument === flag || argument.startsWith(`${flag}=`))
  if (index < 0) return undefined
  return argv[index] === flag ? argv[index + 1] : argv[index].slice(flag.length + 1)
}

/** 仅提取显式本机 CDP 端口。 */
export function explicitUpdateDebugPort(argv: readonly string[]): number | undefined {
  const port = argumentValue(argv, PORT_SWITCH)
  const address = argumentValue(argv, ADDRESS_SWITCH)
  if (address !== undefined && ![LOOPBACK, 'localhost', '::1'].includes(address)) return undefined
  if (!port || !/^\d+$/.test(port)) return undefined
  const number = Number(port)
  return isValidDebugPort(number) ? number : undefined
}

export function isValidDebugPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isSafeInteger(port) && port >= 0 && port <= MAX_PORT
}

export function updateDebugArguments(argv: readonly string[]): string[] {
  const port = explicitUpdateDebugPort(argv)
  return port === undefined ? [] : [`${ADDRESS_SWITCH}=${LOOPBACK}`, `${PORT_SWITCH}=${port}`]
}

export function restoreUpdateDebugPort(
  commandLine: { hasSwitch: (name: string) => boolean; appendSwitch: (name: string, value: string) => void },
  context: { debugPort?: number }
): void {
  if (context.debugPort === undefined || commandLine.hasSwitch(PORT_SWITCH.slice(2)) || commandLine.hasSwitch('remote-debugging-pipe')) return
  commandLine.appendSwitch(ADDRESS_SWITCH.slice(2), LOOPBACK)
  commandLine.appendSwitch(PORT_SWITCH.slice(2), String(context.debugPort))
}
