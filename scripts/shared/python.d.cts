export interface PythonIdentity {
  python: string
  sqlite: string
  platform: string
  machine: string
  executable: string
  base_prefix: string
  prefix: string
  scripts: string
}
export interface PythonRelease {
  archive: string
  bytes: number
  executable: string
  machine: string
  platform: string
  python: string
  sha256: string
  sqlite: string
  triple: string
  url: string
  venvExecutable: string
}
export function pythonRelease(repo: string, platform?: string, arch?: string): PythonRelease
export function preparePython(repo: string): Promise<string>
export function inspectPython(executable: string): PythonIdentity
export function verifyDevelopmentPython(repo: string, executable: string): PythonIdentity
export function inspectPythonAsync(executable: string): Promise<PythonIdentity>
export function verifyDevelopmentPythonAsync(repo: string, executable: string): Promise<PythonIdentity>
