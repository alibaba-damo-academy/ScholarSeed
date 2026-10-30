const SYSTEM_NAMES = new Map([
  ['Darwin', 'macOS'],
  ['Windows_NT', 'Windows'],
])

export function formatSystemVersion(name: string, version: string, architecture: string): string {
  return `${SYSTEM_NAMES.get(name) ?? name} ${version} (${architecture})`
}
