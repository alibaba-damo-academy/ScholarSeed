export interface SubmissionGate {
  current: boolean
}

export function claimSubmission(gate: SubmissionGate): boolean {
  if (gate.current) return false
  gate.current = true
  return true
}
