export interface TexliveRelease {
  binDirectory: string
  root: string
  reported: Record<string, string>
  sha256: string
  texlive: string
}
export function resolveVendoredTexlive(desktopRoot: string, platform?: string, arch?: string, log?: (line: string) => void, signal?: AbortSignal): Promise<TexliveRelease>
export function vendoredTexliveLocation(desktopRoot: string, platform?: string, arch?: string, environment?: NodeJS.ProcessEnv): { root: string; binDirectory: string; sha256: string }
export function bundledTexlive(resourcesRoot: string, platform?: string): string

export function texliveStateRoot(runtimeRoot: string, version: string): string
export interface TexliveEnvironmentOptions { binDirectory: string; writableRoot: string; environment?: NodeJS.ProcessEnv; platform?: string; systemFonts?: boolean; version?: string; archiveSha256?: string }
export function prepareTexliveEnvironment(options: TexliveEnvironmentOptions): Record<string, string>
export function rebuildTexliveEnvironment(options: TexliveEnvironmentOptions): Record<string, string>
export function texliveEnvironmentCurrent(options: TexliveEnvironmentOptions): boolean
export function texliveExecutionResources(options: { binDirectory: string; environment?: NodeJS.ProcessEnv; platform?: string; systemFonts?: boolean; version: string; archiveSha256: string }): { readonly version: string; readonly archiveSha256: string; readonly fontDirectories: readonly string[] }

export function reviewedTexliveVersion(platform?: string): string
export function reviewedTexliveArchive(platform?: string, arch?: string): string
export function texliveCacheRelativePaths(version: string): string[]
