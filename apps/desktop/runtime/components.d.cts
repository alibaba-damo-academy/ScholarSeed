export const APP_COMPONENTS_FILENAME: string
export const COMPONENTS_DIRNAME: string
export const COMPONENT_KINDS: readonly string[]
export const COMPONENT_SCHEMA_VERSION: number
export const HOME_ENV: string
export const LOCKS_DIRNAME: string
export const MANIFESTS_DIRNAME: string
export const PYLIBS_DIRNAME: string
export const PYTHON_ENTRY_RELATIVE: string
export const PYTHON_KIND: string
export const PYTHON_TREE_DIRNAME: string
export const RUNTIME_DIRNAME: string
export const STAGING_DIRNAME: string
export const TEXLIVE_BIN_PARENT_RELATIVE: string
export const TEXLIVE_KIND: string
export const TEXLIVE_TREE_DIRNAME: string

export interface AppComponentEntry {
  kind: string
  contentId: string
  archive: string
  archiveSha256: string
  archiveBytes: number
  entry: string
  executables?: string[]
}

export interface AppComponentsManifest {
  schemaVersion: number
  target: string
  components: AppComponentEntry[]
}

export function componentTarget(platform: string, arch: string): string
export function componentDirectoryName(kind: string, target: string, contentId: string): string
export function componentArchiveName(kind: string, contentId: string): string
export function parseAppComponents(text: string): AppComponentsManifest | null
export function validateAppComponents(value: unknown): boolean
export function storeComponentDirectory(storeRoot: string, kind: string, target: string, contentId: string): string
export function storeManifestPath(storeRoot: string, contentId: string): string
export function storeLockPath(storeRoot: string, contentId: string): string
export function storeStagingDirectory(storeRoot: string): string
export function storeManifestsDirectory(storeRoot: string): string
export function storeLocksDirectory(storeRoot: string): string
export function windowsComponentPreamble(target: string, contentId: string): string[]
export function skillPythonLauncherCommand(target: string, contentId: string, module: string): string
export function consoleScriptLauncherCommand(target: string, contentId: string, pyLaunch: string): string
