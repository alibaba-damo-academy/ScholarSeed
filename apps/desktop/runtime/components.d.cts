export const WINDOWS_BUNDLED_RUNTIME_DIRS: Readonly<{ python: 'python'; texlive: 'texlive'; powershell: 'powershell'; codex: 'codex-runtime'; office: 'office' }>
export function bundledWindowsRuntime(appDirectory: string): { python: string; texlive: string; powershell: string; codex: string; office: string; electron: string }
export const APP_COMPONENTS_FILENAME: string
export const COMPONENTS_DIRNAME: string
export const COMPONENT_KINDS: readonly string[]
export const COMPONENT_SCHEMA_VERSION: number
export const HOME_ENV: string
export const LOCKS_DIRNAME: string
export const MANIFESTS_DIRNAME: string
export const PYLIBS_DIRNAME: string
export const POWERSHELL_ENTRY_RELATIVE: string
export const POWERSHELL_KIND: string
export const POWERSHELL_TREE_DIRNAME: string
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
  // New builds supply all three; absent only in previously published manifests.
  format?: 'zip'
  expandedBytes?: number
  // Counts every archive entry, including directories and empty files.
  fileCount?: number
  entry: string
  executables?: string[]
  version?: string
  python?: string
  sqlite?: string
  texlive?: string
}

export interface AppComponentsManifest {
  schemaVersion: number
  target: string
  components: AppComponentEntry[]
}

export function componentTarget(platform: string, arch: string): string
export function componentDirectoryName(kind: string, target: string, contentId: string): string
export function componentArchiveName(kind: string, contentId: string): string
export function derivePowerShellContentId(input: {
  target: string
  archiveSha256: string
  version: string
}): string
export function parseAppComponents(text: string): AppComponentsManifest | null
export function validateAppComponents(value: unknown): boolean
export function storeComponentDirectory(storeRoot: string, kind: string, target: string, contentId: string): string
export function storeManifestPath(storeRoot: string, contentId: string): string
export function storeLockPath(storeRoot: string, contentId: string): string
export function storeStagingDirectory(storeRoot: string): string
export function storeManifestsDirectory(storeRoot: string): string
export function storeLocksDirectory(storeRoot: string): string
export function windowsComponentPreamble(): string[]
export function runtimeStoreRoot(home: string): string
export function skillPythonLauncherCommand(module: string): string
export function consoleScriptLauncherCommand(pyLaunch: string): string

export const RUNTIME_MANIFEST_FILENAME: string
export const COMPONENT_RECEIPT_FILENAME: string
export const RUNTIME_DOMAIN: string
export const RUNTIME_MANIFEST_LIMIT: number
export const RUNTIME_COMPONENT_KINDS: readonly string[]
export const COMPONENT_VERSION_PATTERN: RegExp
export const RUNTIME_ENTRIES: Readonly<Record<string, string>>
export interface RuntimeComponent {
  kind: string
  version: string
  contentId: string
  archive: string
  archiveSha256: string
  archiveBytes: number
  expandedBytes: number
  fileCount: number
  entry: string
  files: { path: string; size: number; sha256: string }[]
}
export interface RuntimeManifest {
  schema: 1
  domain: 'scholarseed.runtime-components'
  product_id: 'scholarseed'
  bundle_id: 'com.scholarseed.desktop'
  app_id: 'scholarseed'
  target: 'win32-x86_64'
  components: RuntimeComponent[]
}
export function portableRuntimePath(value: unknown): boolean
export function validateRuntimeManifest(value: unknown): value is RuntimeManifest
export function parseRuntimeManifest(text: string): RuntimeManifest | null
export function readRuntimeManifest(appDirectory: string): RuntimeManifest

export const COMPONENT_KIND_PATTERN: RegExp
export const MAX_RUNTIME_COMPONENTS: number
