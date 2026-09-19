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
export function inspectPython(executable: string): PythonIdentity
export function verifyDevelopmentPython(repo: string, executable: string): PythonIdentity
