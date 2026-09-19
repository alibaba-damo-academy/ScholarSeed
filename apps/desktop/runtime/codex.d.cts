export interface CodexRelease {
  path: string
  root: string
  files: { path: string; sha256: string; mode: number }[]
  reported_version: string
  sha256: string
  source: {
    package: string
    distribution: string
    archive_sha256: string
    integrity: string
  }
}
export function resolveVendoredCodex(desktopRoot: string, platform?: string, arch?: string, log?: (line: string) => void): Promise<CodexRelease>
export function bundledCodex(resourcesRoot: string): string
