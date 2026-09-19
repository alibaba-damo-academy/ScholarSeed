export interface TexliveRelease {
  binDirectory: string
  root: string
  reported: Record<string, string>
  sha256: string
  texlive: string
}
export function resolveVendoredTexlive(desktopRoot: string, platform?: string, arch?: string, log?: (line: string) => void): Promise<TexliveRelease>
export function bundledTexlive(resourcesRoot: string, platform?: string): string
