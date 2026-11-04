export interface RecoveryProbe {
  executable: string
  manifest: string
  manifestSha256: string
}

export function buildRecoveryProbe(output: string): RecoveryProbe
export function resolveRecoveryProbe(output: string): RecoveryProbe

export interface RecoveryMaintenance extends RecoveryProbe {
  lease: string
  terminal: string
}

export function buildRecoveryMaintenance(
  output: string,
  inputs: { headers: string; license: string }
): Promise<RecoveryMaintenance>
export function resolveRecoveryMaintenance(output: string): RecoveryMaintenance
