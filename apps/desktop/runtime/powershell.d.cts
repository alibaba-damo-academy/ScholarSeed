export class PowerShellProbeError extends Error {}

export interface PowerShellArtifact {
  archive: string
  bytes: number
  entry: string
  machine: string
  sha256: string
  source: string
  url: string
  version: string
}

export interface PowerShellProbe {
  version: string
}

export const EXECUTABLE_NAME: string
export const PROBE_SCRIPT: string
export const TREE_DIRECTORY: string
export function artifact(desktopRoot: string, platform?: string, arch?: string): PowerShellArtifact
export function parseProbeOutput(output: string, expectedVersion: string): PowerShellProbe
export function probe(executable: string, expectedVersion: string): Promise<PowerShellProbe>
export function stagedExecutable(resourcesRoot: string): string
export function stagedRoot(resourcesRoot: string): string
export function stageVerifiedPowerShell(
  backendDirectory: string,
  desktopRoot: string,
  platform?: string,
  arch?: string
): Promise<{
  executable: string
  root: string
  reported: PowerShellProbe
  sha256: string
  version: string
}>
