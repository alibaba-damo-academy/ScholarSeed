import { win32 } from 'node:path'

export const TOOL_RESOURCES_ENV = 'SCHOLARSEED_TOOL_RESOURCES'
export const TOOL_RESOURCES_REQUIRED_ENV = 'SCHOLARSEED_TOOL_RESOURCES_REQUIRED'
export const TOOL_PRINCIPAL_ENV = 'SCHOLARSEED_TOOL_PRINCIPAL'
const WINDOWS_PLATFORM = 'win32'
const PYTHON_EXECUTABLE = 'python.exe'
const LAUNCHERS = 'launchers'
const PYTHON = 'python'
const LIBRARIES = 'libraries'
const POWERSHELL = 'powershell'
const ELECTRON = 'electron'
const TEXLIVE = 'texlive'

export interface CompilerResources {
  readonly version: string
  readonly archiveSha256: string
  readonly fontDirectories: readonly string[]
}

interface ExecutionComponents {
  powershell: string
  electron: string
  texlive: string
}

export function bundledToolResources(
  platform: string,
  bin: string,
  python: string,
  libraries?: string,
  components?: ExecutionComponents
): string {
  if (platform !== WINDOWS_PLATFORM) return ''
  const resources = [
    { kind: LAUNCHERS, path: bin },
    { kind: PYTHON, path: win32.dirname(python) },
    ...(libraries ? [{ kind: LIBRARIES, path: libraries }] : []),
    ...(components
      ? [
          { kind: POWERSHELL, path: win32.dirname(components.powershell) },
          { kind: ELECTRON, path: win32.dirname(components.electron) },
          { kind: TEXLIVE, path: win32.dirname(win32.dirname(components.texlive)) },
        ]
      : []),
  ]
  if (
    win32.basename(python).toLowerCase() !== PYTHON_EXECUTABLE ||
    resources.some(({ path }) => !win32.isAbsolute(path) || win32.parse(path).root === path)
  ) {
    throw new Error('invalid bundled tool resource paths')
  }
  return JSON.stringify(resources)
}
